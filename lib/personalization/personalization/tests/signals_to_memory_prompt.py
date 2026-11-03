"""Run self-evolving prompting from signal-labeled Coco data.

Example:
    COCO_PERSONALIZATION_RECORDS_ROOT="$HOME/Library/Application Support/coco/coco-records" \
    uv run python lib/personalization/personalization/tests/signals_to_memory_prompt.py \
        --prediction-model nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6 \
        --out-dir /tmp/coco-self-evolving-memory \
        --limit 8
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

from dotenv import load_dotenv
from personalization.labeling import label_records
from personalization.memory import EvolveConfig, SelfEvolvingLearner
from personalization.memory.state import MemoryOp, SectionedMemory
from personalization.records import flatten_sessions, load_records
from personalization.schemas import (
    FeedbackEvent,
    LabeledMoment,
    ObservationRecord,
    SessionRecords,
    TutorCallRecord,
)
from personalization.signals import derive_short_window_signals

load_dotenv()

REAL_DATA_ENV = ("COCO_PERSONALIZATION_RECORDS_ROOT", "COCO_RECORDS_ROOT")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run the full self-evolving memory loop over signal-backed labeled "
            "Coco moments."
        )
    )
    parser.add_argument(
        "--records-root",
        default=_records_root_from_env(),
        help=(
            "Coco records root. Defaults to COCO_PERSONALIZATION_RECORDS_ROOT "
            "or COCO_RECORDS_ROOT."
        ),
    )
    parser.add_argument(
        "--out-dir",
        "--out",
        dest="out_dir",
        required=True,
        help="Directory for memory.md, memory_state.json, and progress.jsonl.",
    )
    parser.add_argument(
        "--prediction-model",
        required=True,
        help="Model that makes support predictions.",
    )
    parser.add_argument(
        "--evolution-model",
        help="Model for reflection, curation, and induction; defaults to the prediction model.",
    )
    parser.add_argument(
        "--start-index",
        "--index",
        dest="start_index",
        type=int,
        default=0,
        help="Start index within signal-backed labeled moments.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Number of signal-backed labeled moments to feed. 0 means all.",
    )
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument(
        "--target-utility",
        type=float,
        help="Stop after an epoch reaches this cost-sensitive utility (maximum 1.0).",
    )
    parser.add_argument("--false-positive-cost", type=float, default=2.0)
    parser.add_argument("--false-negative-cost", type=float, default=1.0)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--max-bullets", type=int, default=60)
    parser.add_argument("--max-ops-per-batch", type=int, default=8)
    parser.add_argument("--reflect-correct", type=int, default=2)
    parser.add_argument("--max-images", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--initial-memory",
        help="Optional initial memory bullet to seed the sectioned memory.",
    )
    parser.add_argument(
        "--synthetic",
        action="store_true",
        help="Use a small built-in record fixture instead of loading real records.",
    )
    args = parser.parse_args(argv)

    try:
        records = (
            _synthetic_records()
            if args.synthetic
            else _load_real_records(args.records_root)
        )
        selected, stats = _select_signal_backed_moments(
            records,
            start_index=args.start_index,
            limit=args.limit,
            min_confidence=args.min_confidence,
            max_images=args.max_images,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir).expanduser()
    memory = _initial_memory(args.initial_memory)
    config = EvolveConfig(
        epochs=args.epochs,
        target_utility=args.target_utility,
        false_positive_cost=args.false_positive_cost,
        false_negative_cost=args.false_negative_cost,
        batch_size=args.batch_size,
        max_bullets=args.max_bullets,
        max_ops_per_batch=args.max_ops_per_batch,
        max_images=args.max_images,
        reflect_correct=args.reflect_correct,
        concurrency=args.concurrency,
        seed=args.seed,
    )
    learner = SelfEvolvingLearner(
        prediction_model=args.prediction_model,
        evolution_model=args.evolution_model,
        config=config,
        memory=memory,
    )

    print(
        json.dumps(
            {
                "mode": "full_self_evolving_pipeline",
                "description": (
                    "Runs Generator, Reflector, Curator, Grow/Refine, and final "
                    "user-model inference with real external_api model calls."
                ),
                "prediction_model": args.prediction_model,
                "evolution_model": args.evolution_model or args.prediction_model,
                "out_dir": str(out_dir),
                "pipeline_counts": stats,
                "config": {
                    "epochs": args.epochs,
                    "target_utility": args.target_utility,
                    "false_positive_cost": args.false_positive_cost,
                    "false_negative_cost": args.false_negative_cost,
                    "batch_size": args.batch_size,
                    "max_bullets": args.max_bullets,
                    "max_ops_per_batch": args.max_ops_per_batch,
                    "reflect_correct": args.reflect_correct,
                    "max_images": args.max_images,
                    "concurrency": args.concurrency,
                    "seed": args.seed,
                },
            },
            indent=2,
        ),
        file=sys.stderr,
    )

    learner.learn(selected, out_dir=out_dir)
    print(
        json.dumps(
            {
                "completed": True,
                "epochs_completed": learner.epochs_completed,
                "final_utility": learner.last_utility,
                "target_utility_reached": learner.target_reached,
                "evolved_memory_bullets": len(learner.memory.bullets),
                "inferred_insights": len(learner.memory.to_learned_preferences()),
                "memory_md": str(out_dir / "memory.md"),
                "memory_state": str(out_dir / "memory_state.json"),
                "progress": str(out_dir / "progress.jsonl"),
            },
            indent=2,
        ),
        file=sys.stderr,
    )
    return 0


def _records_root_from_env() -> str | None:
    return next((os.environ[key] for key in REAL_DATA_ENV if os.environ.get(key)), None)


def _load_real_records(records_root: str | None) -> SessionRecords:
    if not records_root:
        raise ValueError(f"pass --records-root or set {' or '.join(REAL_DATA_ENV)}")
    sessions = load_records(records_root)
    if not sessions:
        raise ValueError(f"no Coco record sessions found under {records_root}")
    return flatten_sessions(sessions)


def _select_signal_backed_moments(
    records: SessionRecords,
    *,
    start_index: int,
    limit: int,
    min_confidence: float,
    max_images: int,
) -> tuple[list[LabeledMoment], dict]:
    signals = derive_short_window_signals(records)
    signal_kinds = {signal.kind for signal in signals}
    all_labeled = label_records(records)
    eligible = [
        moment
        for moment in all_labeled
        if moment.observer_input
        and moment.label_confidence >= min_confidence
        and _is_signal_backed(moment, signal_kinds)
    ]
    if not eligible:
        raise ValueError("records produced no signal-backed labeled moments")
    if start_index < 0 or start_index >= len(eligible):
        raise ValueError(f"--start-index must be between 0 and {len(eligible) - 1}")

    end = None if limit <= 0 else start_index + limit
    selected = [
        _with_existing_images(moment, limit=max_images)
        for moment in eligible[start_index:end]
    ]
    if not selected:
        raise ValueError("selected zero moments; adjust --start-index/--limit")

    stats = {
        "observations": len(records.observations),
        "feedback_events": len(records.feedback),
        "tutor_calls": len(records.tutor_calls),
        "decisions": len(records.decisions),
        "short_window_signals": len(signals),
        "labeled_moments": len(all_labeled),
        "signal_backed_labeled_moments": len(eligible),
        "samples_feeding_self_evolving_prompting": len(selected),
        "start_index": start_index,
        "limit": limit,
        "min_confidence": min_confidence,
        "selected_with_images": sum(1 for moment in selected if moment.image_paths),
        "selected_image_count": sum(len(moment.image_paths) for moment in selected),
    }
    return selected, stats


def _is_signal_backed(moment: LabeledMoment, signal_kinds: set[str]) -> bool:
    return any(
        source in signal_kinds or source.startswith("feedback:")
        for source in moment.label_sources
    )


def _with_existing_images(moment: LabeledMoment, *, limit: int) -> LabeledMoment:
    existing = [
        path for path in moment.image_paths if Path(path).expanduser().is_file()
    ]
    if limit > 0:
        existing = existing[:limit]
    return replace(moment, image_paths=existing)


def _initial_memory(initial_memory: str | None) -> SectionedMemory:
    memory = SectionedMemory()
    if initial_memory:
        memory.apply_ops(
            [MemoryOp(op="add", section="general", content=initial_memory)]
        )
    return memory


def _synthetic_records() -> SessionRecords:
    return SessionRecords(
        path="synthetic-session",
        observations=[
            ObservationRecord(
                observation_id="obs-retry",
                session_id="s1",
                ts=10.0,
                type="observer",
                model="observer-model",
                observer_input="<screenshots>unit test failure repeats</screenshots>",
                observer_output=json.dumps(
                    {
                        "status": "progress",
                        "observation": "The user reruns a unit test and sees the same failing assertion.",
                        "user_intent": "Fix the failing test.",
                    }
                ),
            ),
            ObservationRecord(
                observation_id="obs-dismiss",
                session_id="s1",
                ts=400.0,
                type="observer",
                model="observer-model",
                observer_input="<screenshots>user reads documentation</screenshots>",
                observer_output=json.dumps(
                    {
                        "status": "progress",
                        "observation": "The user is reading API documentation without visible blockage.",
                        "user_intent": "Understand the API.",
                    }
                ),
            ),
        ],
        feedback=[
            FeedbackEvent(
                ts=405.0,
                session_id="s1",
                kind="dismiss",
                surface="bubble",
                observation_id="obs-dismiss",
                text="not useful right now",
            )
        ],
        tutor_calls=[
            TutorCallRecord(
                ts=30.0,
                session_id="s1",
                trigger="user_prompt",
                scenario="debugging",
                model="tutor-model",
                tutor_input="Why is this test still failing?",
                tutor_output="Check the expected value in the assertion.",
            )
        ],
    )


if __name__ == "__main__":
    raise SystemExit(main())
