"""The self-evolving learning loop.

``SelfEvolvingLearner`` reads through a persona's labeled moments and evolves a
``SectionedMemory`` of the user's preferences with NO weight updates, following
the ACE (https://arxiv.org/abs/2510.04618), ACON (https://arxiv.org/abs/2510.00615):
1. For each batch, it generates predictions under the current memory,
2. Reflects on the gaps against ground truth,
3. Curates reflections into incremental delta ops on a sectioned bullet memory,
4. Grows and refines that detailed memory using helpful/harmful votes, and
5. Infers a compact user model, retaining selected detailed bullets as examples.

"""

from __future__ import annotations

import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from personalization.memory.roles import curate, generate, infer_memory, reflect
from personalization.memory.state import SectionedMemory
from personalization.schemas import LabeledMoment


@dataclass(slots=True)
class EvolveConfig:
    """Hyper-parameters for the loop; defaults match the personalization baseline."""

    epochs: int = 1
    target_utility: float | None = None
    false_positive_cost: float = 2.0
    false_negative_cost: float = 1.0
    batch_size: int = 16  # generator calls per curator update
    max_bullets: int = 60
    max_ops_per_batch: int = 8
    max_images: int = 8
    reflect_correct: int = 2  # correct examples reflected per batch (wrong: all)
    gen_max_tokens: int = 4096
    role_max_tokens: int = 20480
    concurrency: int = 8
    seed: int = 42

    def __post_init__(self) -> None:
        if self.target_utility is not None and self.target_utility > 1.0:
            raise ValueError("target_utility cannot exceed the maximum utility of 1.0")
        if self.false_positive_cost < 0 or self.false_negative_cost < 0:
            raise ValueError("utility error costs must be non-negative")


@dataclass(slots=True)
class UtilityStats:
    """Confusion counts and cost-sensitive utility for generator predictions."""

    true_positive: int = 0
    true_negative: int = 0
    false_positive: int = 0
    false_negative: int = 0
    invalid: int = 0

    def add(self, results: list[dict]) -> None:
        for result in results:
            prediction = result.get("pred")
            ground_truth = result.get("gt")
            if prediction not in ("yes", "no") or ground_truth not in ("yes", "no"):
                self.invalid += 1
            elif prediction == "yes" and ground_truth == "yes":
                self.true_positive += 1
            elif prediction == "no" and ground_truth == "no":
                self.true_negative += 1
            elif prediction == "yes":
                self.false_positive += 1
            else:
                self.false_negative += 1

    @property
    def total(self) -> int:
        return (
            self.true_positive
            + self.true_negative
            + self.false_positive
            + self.false_negative
            + self.invalid
        )

    def utility(
        self, *, false_positive_cost: float, false_negative_cost: float
    ) -> float:
        if not self.total:
            return 0.0
        invalid_cost = max(false_positive_cost, false_negative_cost)
        score = (
            self.true_positive
            + self.true_negative
            - false_positive_cost * self.false_positive
            - false_negative_cost * self.false_negative
            - invalid_cost * self.invalid
        )
        return round(score / self.total, 4)

    def to_json(self) -> dict:
        return {
            "true_positive": self.true_positive,
            "true_negative": self.true_negative,
            "false_positive": self.false_positive,
            "false_negative": self.false_negative,
            "invalid": self.invalid,
            "total": self.total,
        }


class SelfEvolvingLearner:
    """Evolve memory with independently configurable prediction/evolution models."""

    def __init__(
        self,
        *,
        prediction_model: str,
        evolution_model: str | None = None,
        image_root: str | Path | None = None,
        config: EvolveConfig | None = None,
        memory: SectionedMemory | None = None,
    ) -> None:
        """
        Evolve memory based on user interaction data.

        Args:
            prediction_model: The model to use for prediction.
            evolution_model: The model to use for evolution.
            image_root: The root directory of the image files.
            config: The configuration for the loop.
            memory: The memory to evolve.
        """
        if not prediction_model:
            raise ValueError("prediction_model is required")
        self.prediction_model = prediction_model
        self.evolution_model = evolution_model or prediction_model
        self.image_root = (
            Path(image_root).expanduser() if image_root is not None else None
        )
        self.cfg = config or EvolveConfig()
        self.memory = memory or SectionedMemory()
        self.epochs_completed = 0
        self.last_utility: float | None = None
        self.target_reached = False

    # -- roles ------------------------------------------------------------- #

    def _generate_batch(
        self, batch: list[LabeledMoment], memory_text: str
    ) -> list[dict]:
        with ThreadPoolExecutor(max_workers=self.cfg.concurrency) as pool:
            return list(
                pool.map(
                    lambda moment: generate(
                        self.prediction_model,
                        moment,
                        memory_text,
                        image_root=self.image_root,
                        max_images=self.cfg.max_images,
                        max_tokens=self.cfg.gen_max_tokens,
                    ),
                    batch,
                )
            )

    def _reflect_batch(self, results: list[dict], memory_text: str) -> list[dict]:
        with ThreadPoolExecutor(max_workers=self.cfg.concurrency) as pool:
            reflections = pool.map(
                lambda res: reflect(
                    self.evolution_model,
                    res,
                    memory_text,
                    max_tokens=self.cfg.role_max_tokens,
                ),
                results,
            )
        return [r for r in reflections if r]

    def _evaluate_current_utility(self, moments: list[LabeledMoment]) -> UtilityStats:
        """Evaluate the current completed memory without applying more updates."""
        stats = UtilityStats()
        memory_text = self.memory.render_evolved(with_ids=True)
        for start in range(0, len(moments), self.cfg.batch_size):
            stats.add(
                self._generate_batch(
                    moments[start : start + self.cfg.batch_size], memory_text
                )
            )
        return stats

    # -- learning loop ----------------------------------------------------- #

    def learn(
        self,
        moments: list[LabeledMoment],
        *,
        out_dir: str | Path | None = None,
        log: bool = True,
    ) -> SectionedMemory:
        cfg = self.cfg
        out = Path(out_dir).expanduser() if out_dir else None
        if out is not None:
            out.mkdir(parents=True, exist_ok=True)
        state_path = out / "memory_state.json" if out else None
        md_path = out / "memory.md" if out else None
        log_fh = (out / "progress.jsonl").open("a") if out else None

        # Any prior inference is stale as soon as detailed evolution resumes.
        self.memory.inferred = None
        rng = random.Random(cfg.seed)
        for epoch in range(1, cfg.epochs + 1):
            order = list(range(len(moments)))
            rng.shuffle(order)
            n_correct = n_seen = 0
            epoch_stats = UtilityStats()
            for start in range(0, len(order), cfg.batch_size):
                batch = [moments[i] for i in order[start : start + cfg.batch_size]]
                memory_text = self.memory.render_evolved(with_ids=True)

                results = self._generate_batch(batch, memory_text)
                batch_stats = UtilityStats()
                batch_stats.add(results)
                epoch_stats.add(results)
                n_seen += len(results)
                n_correct += sum(r["correct"] for r in results)

                wrong = [r for r in results if not r["correct"]]
                right = [r for r in results if r["correct"]][: cfg.reflect_correct]
                reflections = self._reflect_batch(wrong + right, memory_text)
                for r in reflections:
                    self.memory.vote(
                        r.get("helpful_bullet_ids", []), r.get("harmful_bullet_ids", [])
                    )

                n_applied = (
                    self.memory.apply_ops(
                        curate(
                            self.evolution_model,
                            self.memory,
                            reflections,
                            max_ops=cfg.max_ops_per_batch,
                            max_tokens=cfg.role_max_tokens,
                        ),
                        max_ops=cfg.max_ops_per_batch,
                    )
                    if reflections
                    else 0
                )
                n_dropped = self.memory.refine(max_bullets=cfg.max_bullets)

                batch_no = start // cfg.batch_size + 1
                rec = {
                    "epoch": epoch,
                    "batch": batch_no,
                    "batch_acc": round(
                        sum(r["correct"] for r in results) / len(results), 4
                    ),
                    "running_acc": round(n_correct / n_seen, 4),
                    "batch_utility": batch_stats.utility(
                        false_positive_cost=cfg.false_positive_cost,
                        false_negative_cost=cfg.false_negative_cost,
                    ),
                    "running_utility": epoch_stats.utility(
                        false_positive_cost=cfg.false_positive_cost,
                        false_negative_cost=cfg.false_negative_cost,
                    ),
                    "running_confusion": epoch_stats.to_json(),
                    "n_wrong": len(wrong),
                    "n_reflections": len(reflections),
                    "ops_applied": n_applied,
                    "bullets_dropped": n_dropped,
                    "n_bullets": len(self.memory.bullets),
                }
                if log_fh:
                    log_fh.write(json.dumps(rec) + "\n")
                    log_fh.flush()
                if log:
                    print(
                        f"[epoch {epoch} batch {batch_no}] acc={rec['batch_acc']:.2f} "
                        f"utility={rec['batch_utility']:.2f} "
                        f"(running {rec['running_utility']:.2f}) wrong={len(wrong)} "
                        f"ops={n_applied} bullets={len(self.memory.bullets)}",
                        file=sys.stderr,
                    )
                # Checkpoint after every batch so a crash/preemption loses nothing.
                if state_path:
                    state_path.write_text(json.dumps(self.memory.to_json(), indent=2))
                    md_path.write_text(
                        self.memory.render_evolved(with_ids=False) + "\n"
                    )

            self.epochs_completed = epoch
            online_utility = epoch_stats.utility(
                false_positive_cost=cfg.false_positive_cost,
                false_negative_cost=cfg.false_negative_cost,
            )
            measured_stats = (
                self._evaluate_current_utility(moments)
                if cfg.target_utility is not None
                else epoch_stats
            )
            self.last_utility = measured_stats.utility(
                false_positive_cost=cfg.false_positive_cost,
                false_negative_cost=cfg.false_negative_cost,
            )
            self.target_reached = (
                cfg.target_utility is not None
                and measured_stats.total > 0
                and self.last_utility >= cfg.target_utility
            )
            epoch_rec = {
                "event": "epoch_end",
                "epoch": epoch,
                "online_utility": online_utility,
                "measured_utility": self.last_utility,
                "utility_confusion": measured_stats.to_json(),
                "target_utility": cfg.target_utility,
                "target_reached": self.target_reached,
            }
            if log_fh:
                log_fh.write(json.dumps(epoch_rec) + "\n")
                log_fh.flush()
            if log:
                print(
                    f"=== epoch {epoch} done: train acc {n_correct / max(n_seen, 1):.4f}, "
                    f"online utility {online_utility:.4f}, "
                    f"measured utility {self.last_utility:.4f}, "
                    f"{len(self.memory.bullets)} bullets ===",
                    file=sys.stderr,
                )
            if self.target_reached:
                if log:
                    print(
                        f"=== target utility {cfg.target_utility:.4f} reached; "
                        "stopping evolution ===",
                        file=sys.stderr,
                    )
                break

        if self.memory.bullets:
            self.memory.inferred = infer_memory(
                self.evolution_model,
                self.memory,
                max_tokens=cfg.role_max_tokens,
            )
            if log and self.memory.inferred is None:
                print(
                    "warning: final memory inference returned no usable insights; "
                    "keeping detailed memory output",
                    file=sys.stderr,
                )

        if state_path:
            state_path.write_text(json.dumps(self.memory.to_json(), indent=2))
            md_path.write_text(self.memory.render(with_ids=False) + "\n")

        if log_fh:
            log_fh.close()
        return self.memory
