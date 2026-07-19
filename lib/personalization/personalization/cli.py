"""Command-line entry points for Coco personalization."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from personalization.dataset_builder import build_sft_examples, temporal_split
from personalization.exporters import (
    write_labeled_moments,
    write_sft_jsonl,
    write_sharegpt_json,
)
from personalization.labeling import label_records
from personalization.memory import (
    EvolveConfig,
    SelfEvolvingLearner,
)
from personalization.memory_store import MemoryStore, create_memory_draft
from personalization.privacy import RetentionPolicy, prune_old_files
from personalization.prompt_context import render_personalization_context
from personalization.records import flatten_sessions, load_records
from personalization.signals import derive_short_window_signals
from personalization.signals.user_feedback_inspector import (
    inspect_feedback_interactively,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Coco personalization utilities")
    sub = parser.add_subparsers(dest="cmd", required=True)

    summary = sub.add_parser("summary", help="Summarize local Coco records")
    summary.add_argument("--records-root", required=True)

    label = sub.add_parser("label", help="Derive labeled assistance moments")
    label.add_argument("--records-root", required=True)
    label.add_argument("--out", required=True)
    label.add_argument("--min-abs-score", type=float, default=0.45)

    dataset = sub.add_parser("build-dataset", help="Export SFT examples")
    dataset.add_argument("--records-root", required=True)
    dataset.add_argument("--out-dir", required=True)
    dataset.add_argument("--min-confidence", type=float, default=0.0)
    dataset.add_argument("--eval-fraction", type=float, default=0.2)
    dataset.add_argument("--require-images", action="store_true")

    context = sub.add_parser("render-context", help="Render layered prompt context")
    context.add_argument("--memory-root", required=True)
    context.add_argument("--user-memory-path")
    context.add_argument("--records-root")

    prune = sub.add_parser("prune", help="Prune old local personalization files")
    prune.add_argument("--root", required=True)
    prune.add_argument("--days", type=int, default=30)
    prune.add_argument("--apply", action="store_true")

    inspect_feedback = sub.add_parser(
        "inspect-feedback",
        help="Interactively inspect user feedback to signal conversion",
    )
    inspect_feedback.add_argument("--records-root", required=True)
    inspect_feedback.add_argument(
        "--limit",
        type=int,
        default=80,
        help="Rows to show in the table before prompting",
    )

    evolve = sub.add_parser(
        "self-evolve",
        help="Self-evolving prompting: learn a preference memory from records (no weight updates)",
    )
    evolve.add_argument("--records-root", required=True)
    evolve.add_argument(
        "--out-dir",
        required=True,
        help="memory.md / memory_state.json / progress.jsonl",
    )
    evolve.add_argument(
        "--memory-root",
        help="MemoryStore root to also write an approvable MemoryDraft into",
    )
    evolve.add_argument("--image-root", help="root the moment image paths join onto")
    evolve.add_argument("--persona", help="persona tag for the generated memory draft")
    evolve.add_argument(
        "--prediction-model",
        required=True,
        help=(
            "model that makes support predictions, routed by external_api; "
            "e.g. openai/gpt-4.1, "
            "lm_studio/model, nv_inference/model, oa/model, tinfoil/model"
        ),
    )
    evolve.add_argument(
        "--evolution-model",
        help="Model for reflection, curation, and induction; defaults to the prediction model.",
    )
    evolve.add_argument("--min-confidence", type=float, default=0.0)
    evolve.add_argument("--epochs", type=int, default=1)
    evolve.add_argument(
        "--target-utility",
        type=float,
        help="Stop after an epoch reaches this cost-sensitive utility (maximum 1.0).",
    )
    evolve.add_argument("--false-positive-cost", type=float, default=2.0)
    evolve.add_argument("--false-negative-cost", type=float, default=1.0)
    evolve.add_argument("--batch-size", type=int, default=16)
    evolve.add_argument("--max-bullets", type=int, default=60)
    evolve.add_argument("--max-ops-per-batch", type=int, default=8)
    evolve.add_argument("--max-images", type=int, default=8)
    evolve.add_argument("--concurrency", type=int, default=8)

    args = parser.parse_args(argv)
    if args.cmd == "summary":
        return _cmd_summary(args)
    if args.cmd == "label":
        return _cmd_label(args)
    if args.cmd == "build-dataset":
        return _cmd_build_dataset(args)
    if args.cmd == "render-context":
        return _cmd_render_context(args)
    if args.cmd == "prune":
        return _cmd_prune(args)
    if args.cmd == "inspect-feedback":
        return _cmd_inspect_feedback(args)
    if args.cmd == "self-evolve":
        return _cmd_self_evolve(args)
    parser.error(f"unknown command: {args.cmd}")
    return 2


def _load_flat_records(records_root: str):
    sessions = load_records(records_root)
    return sessions, flatten_sessions(sessions)


def _cmd_summary(args) -> int:
    sessions, records = _load_flat_records(args.records_root)
    signals = derive_short_window_signals(records)
    payload = {
        "sessions": len(sessions),
        "observations": len(records.observations),
        "feedback": len(records.feedback),
        "tutor_calls": len(records.tutor_calls),
        "decisions": len(records.decisions),
        "short_window_signals": len(signals),
    }
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_label(args) -> int:
    _, records = _load_flat_records(args.records_root)
    labeled = label_records(records, min_abs_score=args.min_abs_score)
    write_labeled_moments(args.out, labeled)
    print(f"wrote {len(labeled)} labeled moments to {args.out}", file=sys.stderr)
    return 0


def _cmd_build_dataset(args) -> int:
    _, records = _load_flat_records(args.records_root)
    labeled = [
        moment
        for moment in label_records(records)
        if moment.label_confidence >= args.min_confidence
    ]
    train, eval_ = temporal_split(labeled, eval_fraction=args.eval_fraction)
    out_dir = Path(args.out_dir).expanduser()
    train_examples = build_sft_examples(
        train,
        split="train",
        require_images=args.require_images,
        min_confidence=args.min_confidence,
    )
    eval_examples = build_sft_examples(
        eval_,
        split="eval",
        require_images=args.require_images,
        min_confidence=args.min_confidence,
    )
    write_labeled_moments(out_dir / "labeled_moments.jsonl", labeled)
    write_sft_jsonl(out_dir / "sft_train.jsonl", train_examples)
    write_sft_jsonl(out_dir / "sft_eval.jsonl", eval_examples)
    write_sharegpt_json(out_dir / "sharegpt_train.json", train_examples)
    write_sharegpt_json(out_dir / "sharegpt_eval.json", eval_examples)
    print(
        f"wrote train={len(train_examples)} eval={len(eval_examples)} examples to {out_dir}",
        file=sys.stderr,
    )
    return 0


def _cmd_render_context(args) -> int:
    store = MemoryStore(args.memory_root, user_memory_path=args.user_memory_path)
    user_memory = store.load_user_memory()
    learned = store.load_learned_preferences()
    signals = []
    if args.records_root:
        _, records = _load_flat_records(args.records_root)
        signals = derive_short_window_signals(records)
    print(
        render_personalization_context(
            user_memory=user_memory,
            short_window_signals=signals,
            learned_preferences=learned,
        )
    )
    return 0


def _cmd_prune(args) -> int:
    result = prune_old_files(
        args.root,
        policy=RetentionPolicy(records_days=args.days, dry_run=not args.apply),
    )
    print(json.dumps(result.__dict__, indent=2))
    return 0


def _cmd_inspect_feedback(args) -> int:
    return inspect_feedback_interactively(args.records_root, limit=args.limit)


def _cmd_self_evolve(args) -> int:
    _, records = _load_flat_records(args.records_root)
    signals = derive_short_window_signals(records)
    all_labeled = label_records(records)
    labeled = [
        moment
        for moment in all_labeled
        if moment.label_confidence >= args.min_confidence
    ]
    if not labeled:
        print("no labeled training moments to evolve from", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "models": {
                    "prediction": args.prediction_model,
                    "evolution": args.evolution_model or args.prediction_model,
                },
                "self_evolve_input_counts": {
                    "observations": len(records.observations),
                    "feedback_events": len(records.feedback),
                    "tutor_calls": len(records.tutor_calls),
                    "decisions": len(records.decisions),
                    "short_window_signals": len(signals),
                    "labeled_moments": len(all_labeled),
                    "samples_feeding_self_evolving_prompting": len(labeled),
                    "min_confidence": args.min_confidence,
                },
            },
            indent=2,
        ),
        file=sys.stderr,
    )

    learner = SelfEvolvingLearner(
        prediction_model=args.prediction_model,
        evolution_model=args.evolution_model,
        image_root=args.image_root,
        config=EvolveConfig(
            epochs=args.epochs,
            target_utility=args.target_utility,
            false_positive_cost=args.false_positive_cost,
            false_negative_cost=args.false_negative_cost,
            batch_size=args.batch_size,
            max_bullets=args.max_bullets,
            max_ops_per_batch=args.max_ops_per_batch,
            max_images=args.max_images,
            concurrency=args.concurrency,
        ),
    )
    out_dir = Path(args.out_dir).expanduser()
    learner.learn(labeled, out_dir=out_dir)

    # Promote the inferred insights into an approvable MemoryDraft so a human can
    # review before they ever influence the live layered prompt context.
    if args.memory_root:
        store = MemoryStore(args.memory_root)
        draft = create_memory_draft(
            source_run_id=f"self-evolve:{args.persona or 'default'}",
            based_on_user_memory=store.load_user_memory().text,
            bullets=learner.memory.to_learned_preferences(status="draft"),
            summary=(
                "Self-evolved memory "
                f"({len(learner.memory.to_learned_preferences())} insights)"
            ),
        )
        path = store.save_draft(draft)
        print(f"wrote memory draft -> {path}", file=sys.stderr)

    print(
        f"inferred {len(learner.memory.to_learned_preferences())} insights from "
        f"{len(learner.memory.bullets)} evolved bullets after "
        f"{learner.epochs_completed} epochs (utility={learner.last_utility}) "
        f"-> {out_dir}/memory.md",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
