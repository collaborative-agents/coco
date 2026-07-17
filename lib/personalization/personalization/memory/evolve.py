"""The self-evolving learning loop.

``SelfEvolvingLearner`` reads through a persona's labeled moments and evolves a
``SectionedMemory`` of the user's preferences with NO weight updates, following
the ACE (https://arxiv.org/abs/2510.04618), ACON (https://arxiv.org/abs/2510.00615):
1. For each batch, it generates predictions under the current memory,
2. Reflects on the gaps against ground truth,
3. Curates a batch of reflections into
Maintain a sectioned bullet memory and update it with incremental delta ops,
then grow and refine the memory (votes reinforce/penalize bullets,
the lowest-utility bullets are dropped over the cap).

"""

from __future__ import annotations

import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from personalization.memory.roles import curate, generate, reflect
from personalization.memory.state import SectionedMemory
from personalization.schemas import LabeledMoment


@dataclass(slots=True)
class EvolveConfig:
    """Hyper-parameters for the loop; defaults match the personalization baseline."""

    epochs: int = 1
    batch_size: int = 16  # generator calls per curator update
    max_bullets: int = 60
    max_ops_per_batch: int = 8
    max_images: int = 8
    reflect_correct: int = 2  # correct examples reflected per batch (wrong: all)
    gen_max_tokens: int = 4096
    role_max_tokens: int = 20480
    concurrency: int = 8
    seed: int = 42


class SelfEvolvingLearner:
    """Evolve a ``SectionedMemory`` from labeled examples via a served model."""

    def __init__(
        self,
        model: str,
        *,
        image_root: str | Path | None = None,
        config: EvolveConfig | None = None,
        memory: SectionedMemory | None = None,
    ) -> None:
        self.model = model
        self.image_root = (
            Path(image_root).expanduser() if image_root is not None else None
        )
        self.cfg = config or EvolveConfig()
        self.memory = memory or SectionedMemory()

    # -- roles ------------------------------------------------------------- #

    def _generate_batch(
        self, batch: list[LabeledMoment], memory_text: str
    ) -> list[dict]:
        with ThreadPoolExecutor(max_workers=self.cfg.concurrency) as pool:
            return list(
                pool.map(
                    lambda moment: generate(
                        self.model,
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
                    self.model,
                    res,
                    memory_text,
                    max_tokens=self.cfg.role_max_tokens,
                ),
                results,
            )
        return [r for r in reflections if r]

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

        rng = random.Random(cfg.seed)
        for epoch in range(1, cfg.epochs + 1):
            order = list(range(len(moments)))
            rng.shuffle(order)
            n_correct = n_seen = 0
            for start in range(0, len(order), cfg.batch_size):
                batch = [moments[i] for i in order[start : start + cfg.batch_size]]
                memory_text = self.memory.render(with_ids=True)

                results = self._generate_batch(batch, memory_text)
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
                            self.model,
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
                        f"(running {rec['running_acc']:.2f}) wrong={len(wrong)} "
                        f"ops={n_applied} bullets={len(self.memory.bullets)}",
                        file=sys.stderr,
                    )
                # Checkpoint after every batch so a crash/preemption loses nothing.
                if state_path:
                    state_path.write_text(json.dumps(self.memory.to_json(), indent=2))
                    md_path.write_text(self.memory.render(with_ids=False) + "\n")

            if log:
                print(
                    f"=== epoch {epoch} done: train acc {n_correct / max(n_seen, 1):.4f}, "
                    f"{len(self.memory.bullets)} bullets ===",
                    file=sys.stderr,
                )

        if log_fh:
            log_fh.close()
        return self.memory
