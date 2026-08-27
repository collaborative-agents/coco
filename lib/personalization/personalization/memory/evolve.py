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

import hashlib
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from personalization.memory.roles import curate, generate, infer_memory, reflect
from personalization.memory.state import SectionedMemory
from personalization.schemas import LabeledMoment
from personalization.utils.llm_resilience import transient_llm_error


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
    shuffle: bool = False

    def __post_init__(self) -> None:
        if self.target_utility is not None and self.target_utility > 1.0:
            raise ValueError("target_utility cannot exceed the maximum utility of 1.0")
        if self.false_positive_cost < 0 or self.false_negative_cost < 0:
            raise ValueError("utility error costs must be non-negative")
        if self.batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        if self.concurrency < 1:
            raise ValueError("concurrency must be at least 1")


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

    @classmethod
    def from_json(cls, value: Any) -> UtilityStats:
        data = value if isinstance(value, dict) else {}
        return cls(
            **{
                field: int(data.get(field, 0) or 0)
                for field in (
                    "true_positive",
                    "true_negative",
                    "false_positive",
                    "false_negative",
                    "invalid",
                )
            }
        )


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
        self.skipped_batches: list[dict[str, Any]] = []

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
        resume: bool = False,
    ) -> SectionedMemory:
        cfg = self.cfg
        out = Path(out_dir).expanduser() if out_dir else None
        if resume and out is None:
            raise ValueError("resume requires out_dir")
        if out is not None:
            out.mkdir(parents=True, exist_ok=True)
        state_path = out / "memory_state.json" if out else None
        md_path = out / "memory.md" if out else None
        progress_path = out / "progress.jsonl" if out else None
        resume_path = out / "resume_state.json" if out else None
        signature = _run_signature(self, moments)

        checkpoint = (
            _load_resume_checkpoint(
                resume_path=resume_path,
                state_path=state_path,
                progress_path=progress_path,
                signature=signature,
                cfg=cfg,
            )
            if resume
            else None
        )
        if checkpoint is not None:
            self.memory = SectionedMemory.from_json(checkpoint["memory"])
            self.epochs_completed = int(checkpoint.get("epochs_completed", 0))
            self.last_utility = checkpoint.get("last_utility")
            self.target_reached = bool(checkpoint.get("target_reached", False))
            self.skipped_batches = list(checkpoint.get("skipped_batches") or [])
            if checkpoint.get("status") == "complete":
                if log:
                    print(
                        "self-evolve checkpoint is already complete; nothing to resume",
                        file=sys.stderr,
                    )
                return self.memory
            start_epoch = int(checkpoint.get("next_epoch", 1))
            start_batch = int(checkpoint.get("next_batch", 1))
            restored_stats = UtilityStats.from_json(checkpoint.get("epoch_stats"))
            restored_seen = int(checkpoint.get("n_seen", restored_stats.total))
            restored_correct = int(
                checkpoint.get(
                    "n_correct",
                    restored_stats.true_positive + restored_stats.true_negative,
                )
            )
            finalizing = checkpoint.get("status") == "finalizing"
            if log:
                print(
                    f"resuming self-evolve at epoch {start_epoch}, batch {start_batch}",
                    file=sys.stderr,
                )
        else:
            start_epoch = 1
            start_batch = 1
            restored_stats = UtilityStats()
            restored_seen = restored_correct = 0
            finalizing = False
            if resume_path is not None and resume_path.exists():
                resume_path.unlink()

        log_fh = progress_path.open("a" if resume else "w") if progress_path else None

        def checkpoint_run(
            *,
            status: str,
            next_epoch: int,
            next_batch: int,
            epoch_stats: UtilityStats,
            n_seen: int,
            n_correct: int,
        ) -> None:
            if state_path is None or md_path is None or resume_path is None:
                return
            _atomic_write_json(state_path, self.memory.to_json())
            _atomic_write_text(
                md_path,
                self.memory.render_evolved(with_ids=False) + "\n",
            )
            _atomic_write_json(
                resume_path,
                {
                    "version": 1,
                    "status": status,
                    "signature": signature,
                    "next_epoch": next_epoch,
                    "next_batch": next_batch,
                    "epoch_stats": epoch_stats.to_json(),
                    "n_seen": n_seen,
                    "n_correct": n_correct,
                    "epochs_completed": self.epochs_completed,
                    "last_utility": self.last_utility,
                    "target_reached": self.target_reached,
                    "skipped_batches": self.skipped_batches,
                    "memory": self.memory.to_json(),
                },
            )

        # Any prior inference is stale as soon as detailed evolution resumes.
        self.memory.inferred = None
        rng = random.Random(cfg.seed)
        for _prior_epoch in range(1, start_epoch):
            prior_order = list(range(len(moments)))
            if cfg.shuffle:
                rng.shuffle(prior_order)
        epoch_range = range(start_epoch, cfg.epochs + 1) if not finalizing else range(0)
        for epoch in epoch_range:
            order = list(range(len(moments)))
            if cfg.shuffle:
                rng.shuffle(order)
            resuming_epoch = checkpoint is not None and epoch == start_epoch
            n_correct = restored_correct if resuming_epoch else 0
            n_seen = restored_seen if resuming_epoch else 0
            epoch_stats = restored_stats if resuming_epoch else UtilityStats()
            for start in range(0, len(order), cfg.batch_size):
                batch_no = start // cfg.batch_size + 1
                if resuming_epoch and batch_no < start_batch:
                    continue
                batch = [moments[i] for i in order[start : start + cfg.batch_size]]
                memory_text = self.memory.render_evolved(with_ids=True)
                memory_before_batch = self.memory.to_json()
                batch_started = time.perf_counter()
                try:
                    results = self._generate_batch(batch, memory_text)
                    batch_stats = UtilityStats()
                    batch_stats.add(results)

                    wrong = [r for r in results if not r["correct"]]
                    right = [r for r in results if r["correct"]][: cfg.reflect_correct]
                    reflections = self._reflect_batch(wrong + right, memory_text)
                    for r in reflections:
                        self.memory.vote(
                            r.get("helpful_bullet_ids", []),
                            r.get("harmful_bullet_ids", []),
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
                except Exception as error:
                    if not transient_llm_error(error):
                        raise
                    # A batch is atomic: discard votes/ops applied before a later
                    # role exhausted its retries, then checkpoint past the batch.
                    self.memory = SectionedMemory.from_json(memory_before_batch)
                    skipped = {
                        "event": "batch_skipped",
                        "epoch": epoch,
                        "batch": batch_no,
                        "moment_count": len(batch),
                        "moment_ids": [
                            str(getattr(moment, "moment_id", index))
                            for index, moment in enumerate(batch)
                        ],
                        "error_type": type(error).__name__,
                        "error": str(error)[-4000:],
                        "batch_duration_s": round(
                            time.perf_counter() - batch_started, 2
                        ),
                    }
                    self.skipped_batches.append(skipped)
                    checkpoint_run(
                        status="running",
                        next_epoch=epoch,
                        next_batch=batch_no + 1,
                        epoch_stats=epoch_stats,
                        n_seen=n_seen,
                        n_correct=n_correct,
                    )
                    if log_fh:
                        log_fh.write(json.dumps(skipped) + "\n")
                        log_fh.flush()
                    if log:
                        print(
                            f"[epoch {epoch} batch {batch_no}] skipped after "
                            f"exhausted transient retries: {type(error).__name__}: "
                            f"{error}",
                            file=sys.stderr,
                        )
                    continue

                epoch_stats.add(results)
                n_seen += len(results)
                n_correct += sum(r["correct"] for r in results)
                batch_duration_s = round(time.perf_counter() - batch_started, 2)

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
                    "batch_duration_s": batch_duration_s,
                }
                checkpoint_run(
                    status="running",
                    next_epoch=epoch,
                    next_batch=batch_no + 1,
                    epoch_stats=epoch_stats,
                    n_seen=n_seen,
                    n_correct=n_correct,
                )
                if log_fh:
                    log_fh.write(json.dumps(rec) + "\n")
                    log_fh.flush()
                if log:
                    print(
                        f"[epoch {epoch} batch {batch_no}] acc={rec['batch_acc']:.2f} "
                        f"utility={rec['batch_utility']:.2f} "
                        f"(running {rec['running_utility']:.2f}) wrong={len(wrong)} "
                        f"ops={n_applied} bullets={len(self.memory.bullets)} "
                        f"time={batch_duration_s:.2f}s",
                        file=sys.stderr,
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
            is_final_epoch = epoch >= cfg.epochs or self.target_reached
            checkpoint_run(
                status="finalizing" if is_final_epoch else "running",
                next_epoch=epoch + 1,
                next_batch=1,
                epoch_stats=UtilityStats(),
                n_seen=0,
                n_correct=0,
            )
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

        if state_path and md_path and resume_path:
            _atomic_write_json(state_path, self.memory.to_json())
            _atomic_write_text(md_path, self.memory.render(with_ids=False) + "\n")
            _atomic_write_json(
                resume_path,
                {
                    "version": 1,
                    "status": "complete",
                    "signature": signature,
                    "next_epoch": self.epochs_completed + 1,
                    "next_batch": 1,
                    "epoch_stats": UtilityStats().to_json(),
                    "n_seen": 0,
                    "n_correct": 0,
                    "epochs_completed": self.epochs_completed,
                    "last_utility": self.last_utility,
                    "target_reached": self.target_reached,
                    "skipped_batches": self.skipped_batches,
                    "memory": self.memory.to_json(),
                },
            )

        if log_fh:
            log_fh.close()
        return self.memory


def _run_signature(
    learner: SelfEvolvingLearner,
    moments: list[LabeledMoment],
) -> dict[str, str]:
    moment_rows = [
        moment.to_dict() if hasattr(moment, "to_dict") else repr(moment)
        for moment in moments
    ]
    dataset_json = json.dumps(
        moment_rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    config = asdict(learner.cfg)
    # Concurrency affects throughput, not learning semantics, and is commonly
    # lowered after an overloaded endpoint causes the interrupted run.
    config.pop("concurrency", None)
    configuration_json = json.dumps(
        {
            "prediction_model": learner.prediction_model,
            "evolution_model": learner.evolution_model,
            "image_root": str(learner.image_root) if learner.image_root else None,
            "config": config,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return {
        "dataset_sha256": hashlib.sha256(dataset_json.encode()).hexdigest(),
        "configuration_sha256": hashlib.sha256(configuration_json.encode()).hexdigest(),
    }


def _load_resume_checkpoint(
    *,
    resume_path: Path | None,
    state_path: Path | None,
    progress_path: Path | None,
    signature: dict[str, str],
    cfg: EvolveConfig,
) -> dict[str, Any]:
    if resume_path is None or state_path is None or progress_path is None:
        raise ValueError("resume requires checkpoint paths")
    if resume_path.exists():
        checkpoint = json.loads(resume_path.read_text())
        saved_signature = checkpoint.get("signature")
        if saved_signature != signature:
            changed = [
                name.removesuffix("_sha256")
                for name, value in signature.items()
                if not isinstance(saved_signature, dict)
                or saved_signature.get(name) != value
            ]
            raise ValueError(
                "cannot resume because the " + " and ".join(changed) + " changed"
            )
        if not isinstance(checkpoint.get("memory"), dict):
            raise ValueError("resume_state.json is missing its memory snapshot")
        return checkpoint

    # Compatibility with runs started before resume_state.json existed. The
    # old implementation wrote progress first and memory_state.json second, so
    # this is best-effort; all new checkpoints use the atomic combined state.
    if not state_path.exists() and not progress_path.exists():
        raise FileNotFoundError(
            f"no self-evolve checkpoint found in {resume_path.parent}"
        )
    memory = (
        json.loads(state_path.read_text())
        if state_path.exists() and state_path.stat().st_size
        else SectionedMemory().to_json()
    )
    rows: list[dict[str, Any]] = []
    if progress_path.exists():
        for line in progress_path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    if not rows:
        return {
            "version": 1,
            "status": "running",
            "signature": signature,
            "next_epoch": 1,
            "next_batch": 1,
            "epoch_stats": UtilityStats().to_json(),
            "n_seen": 0,
            "n_correct": 0,
            "epochs_completed": 0,
            "last_utility": None,
            "target_reached": False,
            "memory": memory,
        }

    last = rows[-1]
    if last.get("event") == "epoch_end":
        completed_epoch = int(last.get("epoch", 0))
        target_reached = bool(last.get("target_reached", False))
        return {
            "version": 1,
            "status": (
                "finalizing"
                if target_reached or completed_epoch >= cfg.epochs
                else "running"
            ),
            "signature": signature,
            "next_epoch": completed_epoch + 1,
            "next_batch": 1,
            "epoch_stats": UtilityStats().to_json(),
            "n_seen": 0,
            "n_correct": 0,
            "epochs_completed": completed_epoch,
            "last_utility": last.get("measured_utility"),
            "target_reached": target_reached,
            "memory": memory,
        }

    completed_epoch = int(last.get("epoch", 1))
    stats = UtilityStats.from_json(last.get("running_confusion"))
    return {
        "version": 1,
        "status": "running",
        "signature": signature,
        "next_epoch": completed_epoch,
        "next_batch": int(last.get("batch", 0)) + 1,
        "epoch_stats": stats.to_json(),
        "n_seen": stats.total,
        "n_correct": stats.true_positive + stats.true_negative,
        "epochs_completed": max(0, completed_epoch - 1),
        "last_utility": None,
        "target_reached": False,
        "memory": memory,
    }


def _atomic_write_json(path: Path, value: Any) -> None:
    _atomic_write_text(path, json.dumps(value, indent=2))


def _atomic_write_text(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text)
    temporary.replace(path)
