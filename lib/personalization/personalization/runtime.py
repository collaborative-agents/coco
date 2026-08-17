"""Bounded, checkpointed personalization jobs for the desktop scheduler."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

from personalization.exporters import (
    read_labeled_moments,
    write_labeled_moments,
)
from personalization.labeling import label_records, revise_label_disagreements
from personalization.memory import EvolveConfig, SelfEvolvingLearner
from personalization.memory.state import SectionedMemory
from personalization.memory_store import MemoryStore, create_memory_draft
from personalization.records import flatten_sessions, load_records, read_jsonl
from personalization.signals.missed_opportunities import (
    derive_missed_opportunity_signals,
)
from personalization.signals.user_feedback import derive_feedback_signals

# Internal non-error exit code: the bounded job ran successfully but found no
# eligible work. The desktop scheduler distinguishes this from exit code 0 so
# it can apply a longer retry cooldown without reporting a job failure.
NO_WORK = 3


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    os.replace(temporary, path)


def _append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def process_signal_step(
    records_root: str | Path,
    state_root: str | Path,
    *,
    missed_observation_interval: int = 20,
) -> dict[str, int | bool]:
    """Append unseen feedback signals and periodically refresh missed opportunities."""
    state_dir = Path(state_root).expanduser()
    output_path = state_dir / "signals.jsonl"
    checkpoint_path = state_dir / "signals_checkpoint.json"
    checkpoint = _read_json(checkpoint_path, {})
    sessions = load_records(records_root)
    records = flatten_sessions(sessions)
    existing_ids = {
        str(row.get("signal_id"))
        for row in read_jsonl(output_path)
        if row.get("signal_id")
    }

    derived = derive_feedback_signals(records.feedback)
    last_missed_count = int(checkpoint.get("missed_observation_count", 0) or 0)
    observation_count = len(records.observations)
    ran_missed = (
        observation_count >= missed_observation_interval
        and observation_count - last_missed_count >= missed_observation_interval
    )
    if ran_missed:
        derived.extend(derive_missed_opportunity_signals(records))

    unseen = [signal for signal in derived if signal.signal_id not in existing_ids]
    _append_jsonl(output_path, [signal.to_dict() for signal in unseen])
    _atomic_json(
        checkpoint_path,
        {
            "updated_at": time.time(),
            "feedback_event_count": len(records.feedback),
            "observation_count": observation_count,
            "missed_observation_count": (
                observation_count if ran_missed else last_missed_count
            ),
            "signal_count": len(existing_ids) + len(unseen),
        },
    )
    return {"new_signals": len(unseen), "ran_missed": ran_missed}


def process_revision_step(
    records_root: str | Path,
    state_root: str | Path,
    *,
    model: str,
) -> dict[str, int | str]:
    """Revise at most one unseen disagreement and checkpoint it immediately."""
    state_dir = Path(state_root).expanduser()
    checkpoint_path = state_dir / "revision_checkpoint.json"
    output_path = state_dir / "revised_labels.jsonl"
    checkpoint = _read_json(checkpoint_path, {})
    completed = set(checkpoint.get("completed_moment_ids", []))
    records = flatten_sessions(load_records(records_root))
    labeled = [
        moment for moment in label_records(records) if moment.moment_id not in completed
    ]
    revised, eligible = revise_label_disagreements(
        records,
        labeled,
        model=model,
        limit=1,
        concurrency=1,
        retries=1,
    )
    if not revised:
        return {"status": "no_work", "revised": 0, "eligible": eligible}
    _append_jsonl(output_path, [revised[0].to_dict()])
    completed.add(revised[0].moment_id)
    _atomic_json(
        checkpoint_path,
        {
            "updated_at": time.time(),
            "completed_moment_ids": sorted(completed),
        },
    )
    return {"status": "complete", "revised": 1, "eligible": eligible}


def _safe_delete_images(paths: list[str], records_root: Path) -> int:
    root = records_root.expanduser().resolve()
    deleted = 0
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        try:
            resolved = path.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        try:
            resolved.unlink()
            deleted += 1
        except OSError:
            continue
    return deleted


def process_evolve_step(
    records_root: str | Path,
    state_root: str | Path,
    *,
    model: str,
    memory_root: str | Path,
    collect_training_screenshots: bool,
    min_moments: int = 8,
    max_moments: int = 64,
) -> dict[str, int | str]:
    """Run or resume one frozen Coco-PE period and apply retention on success."""
    records_path = Path(records_root).expanduser()
    state_dir = Path(state_root).expanduser()
    runtime_path = state_dir / "evolve_checkpoint.json"
    runtime_state = _read_json(runtime_path, {})
    active = runtime_state.get("active_run")

    if not isinstance(active, dict) or active.get("status") == "complete":
        completed_until = float(runtime_state.get("completed_until", 0.0) or 0.0)
        records = flatten_sessions(load_records(records_path))
        revised_by_id = {
            moment.moment_id: moment
            for moment in read_labeled_moments(state_dir / "revised_labels.jsonl")
        }
        labeled = [
            revised_by_id.get(moment.moment_id, moment)
            for moment in label_records(records)
        ]
        labeled = sorted(
            (moment for moment in labeled if moment.ts > completed_until),
            key=lambda moment: moment.ts,
        )[:max_moments]
        if len(labeled) < min_moments:
            return {"status": "no_work", "moments": len(labeled)}
        period_end = max(moment.ts for moment in labeled)
        run_id = f"period-{int(period_end)}"
        run_dir = state_dir / "runs" / run_id
        snapshot_path = run_dir / "labeled_moments.jsonl"
        write_labeled_moments(snapshot_path, labeled)
        images = sorted(
            {
                path
                for moment in labeled
                for path in moment.image_paths
                if Path(path).expanduser().is_file()
            }
            | {
                path
                for observation in records.observations
                if completed_until < observation.ts <= period_end
                for path in observation.retained_screenshots
                if Path(path).expanduser().is_file()
            }
        )
        active = {
            "run_id": run_id,
            "status": "running",
            "period_start": min(moment.ts for moment in labeled),
            "period_end": period_end,
            "snapshot_path": str(snapshot_path),
            "run_dir": str(run_dir),
            "images": images,
        }
        runtime_state["active_run"] = active
        _atomic_json(runtime_path, runtime_state)

    run_dir = Path(str(active["run_dir"]))
    snapshot_path = Path(str(active["snapshot_path"]))
    labeled = read_labeled_moments(snapshot_path)
    learner = SelfEvolvingLearner(
        prediction_model=model,
        evolution_model=model,
        config=EvolveConfig(
            epochs=1,
            batch_size=4,
            max_images=2,
            concurrency=1,
            max_ops_per_batch=4,
        ),
    )
    resume_path = run_dir / "resume_state.json"
    previous_state = runtime_state.get("last_memory_state")
    if not resume_path.exists() and isinstance(previous_state, str):
        previous = _read_json(Path(previous_state), None)
        if isinstance(previous, dict):
            learner.memory = SectionedMemory.from_json(previous)
    learner.learn(labeled, out_dir=run_dir, resume=resume_path.exists())

    store = MemoryStore(memory_root)
    learned_preferences = learner.memory.to_learned_preferences(status="draft")
    examples_by_preference_id: dict[str, list[str]] = {}
    if learner.memory.inferred is not None:
        for index, preference in enumerate(learned_preferences):
            if index >= len(learner.memory.inferred.insights):
                break
            insight = learner.memory.inferred.insights[index]
            examples = [
                learner.memory.bullets[bullet_id].content
                for bullet_id in insight.example_bullet_ids
                if bullet_id in learner.memory.bullets
            ]
            if examples:
                examples_by_preference_id[preference.id] = examples
    draft_metrics: dict[str, Any] = {
        "period_start": active["period_start"],
        "period_end": active["period_end"],
        "moment_count": len(labeled),
    }
    if examples_by_preference_id:
        draft_metrics["examples_by_preference_id"] = examples_by_preference_id
    draft = create_memory_draft(
        source_run_id=f"desktop:{active['run_id']}",
        based_on_user_memory=store.load_user_memory(),
        bullets=learned_preferences,
        summary=f"Coco-PE period ending at {active['period_end']}",
        metrics=draft_metrics,
    )
    store.save_draft(draft)

    deleted = 0
    if not collect_training_screenshots:
        deleted = _safe_delete_images(list(active.get("images", [])), records_path)
    active["status"] = "complete"
    active["completed_at"] = time.time()
    active["deleted_images"] = deleted
    runtime_state.update(
        {
            "active_run": active,
            "completed_until": active["period_end"],
            "last_memory_state": str(run_dir / "memory_state.json"),
        }
    )
    _atomic_json(runtime_path, runtime_state)
    return {"status": "complete", "moments": len(labeled), "deleted": deleted}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one bounded personalization job")
    parser.add_argument("job", choices=("signals", "revise", "evolve"))
    parser.add_argument("--records-root", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--model")
    parser.add_argument("--memory-root")
    parser.add_argument("--missed-observation-interval", type=int, default=20)
    parser.add_argument("--min-moments", type=int, default=8)
    parser.add_argument("--max-moments", type=int, default=64)
    parser.add_argument("--collect-training-screenshots", action="store_true")
    args = parser.parse_args(argv)

    if args.job == "signals":
        result = process_signal_step(
            args.records_root,
            args.state_root,
            missed_observation_interval=args.missed_observation_interval,
        )
    elif args.job == "revise":
        if not args.model:
            parser.error("revise requires --model")
        result = process_revision_step(
            args.records_root, args.state_root, model=args.model
        )
    else:
        if not args.model or not args.memory_root:
            parser.error("evolve requires --model and --memory-root")
        result = process_evolve_step(
            args.records_root,
            args.state_root,
            model=args.model,
            memory_root=args.memory_root,
            collect_training_screenshots=args.collect_training_screenshots,
            min_moments=args.min_moments,
            max_moments=args.max_moments,
        )
    print(json.dumps(result))
    return NO_WORK if result.get("status") == "no_work" else 0


if __name__ == "__main__":
    raise SystemExit(main())
