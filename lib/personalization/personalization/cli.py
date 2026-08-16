"""Command-line entry points for Coco personalization."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from personalization.dataset_builder import build_sft_examples, temporal_split
from personalization.exporters import (
    read_labeled_moments,
    write_labeled_moments,
    write_sft_jsonl,
    write_sharegpt_json,
)
from personalization.labeling import label_records, revise_label_disagreements
from personalization.memory import (
    EvolveConfig,
    SelfEvolvingLearner,
    select_evolution_moments,
)
from personalization.memory_store import MemoryStore, create_memory_draft
from personalization.records import flatten_sessions, load_records
from personalization.signals import (
    derive_retrospective_signals,
    derive_short_window_signals,
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
    label.add_argument(
        "--last-days",
        type=_positive_int,
        help="include moments from only the last N rolling 24-hour periods",
    )
    label.add_argument(
        "--retrospective-model",
        help=(
            "on-device model used to scan silent moments for high-value "
            "workflow-level repetition, stuckness, or anticipated needs"
        ),
    )
    label.add_argument(
        "--retrospective-min-confidence",
        type=_unit_float,
        default=0.75,
    )
    label.add_argument(
        "--retrospective-max-observations",
        type=_positive_int,
        default=300,
        help="maximum observations per workflow-discovery chunk",
    )
    label.add_argument(
        "--retrospective-trigger-max-observations",
        type=_positive_int,
        default=50,
        help="maximum observations per trigger-grounding chunk",
    )
    label.add_argument(
        "--retrospective-max-opportunities",
        type=_positive_int,
        default=8,
        help="maximum workflow-level opportunities requested from the model",
    )
    label.add_argument(
        "--retrospective-trace-out",
        help="write exact retrospective inputs, raw outputs, and accepted signals",
    )
    label.add_argument(
        "--no-progress",
        action="store_false",
        dest="show_progress",
        help="disable the retrospective scan progress bar and ETA",
    )
    label.add_argument(
        "--include-unverified-no-support",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="include weak negatives from uncorrected observer no-support predictions",
    )
    label.add_argument(
        "--unverified-no-support-confidence",
        type=float,
        default=0.25,
    )
    label.add_argument(
        "--require-saved-images",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="include only records with at least one image file present on disk",
    )

    revise = sub.add_parser(
        "revise-labels",
        help="Revise a bounded sample of polarity-disagreement labels",
    )
    revise.add_argument("--records-root", required=True)
    revise.add_argument("--labeled", required=True, help="input labeled moments JSONL")
    revise.add_argument("--out", required=True, help="output revised sample JSONL")
    revise.add_argument("--revision-model", required=True)
    revise.add_argument(
        "--limit",
        type=int,
        help="maximum number of disagreement examples to revise (default: all)",
    )
    revise.add_argument("--concurrency", type=int, default=8)
    revise.add_argument(
        "--revision-retries",
        type=int,
        default=2,
        help="retries per label after an invalid model response (default: 2)",
    )

    dataset = sub.add_parser("build-dataset", help="Export SFT examples")
    dataset.add_argument("--records-root", required=True)
    dataset.add_argument("--out-dir", required=True)
    dataset.add_argument("--min-confidence", type=float, default=0.0)
    dataset.add_argument("--eval-fraction", type=float, default=0.2)
    dataset.add_argument("--require-images", action="store_true")
    dataset.add_argument(
        "--include-unverified-no-support",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="include weak negatives from uncorrected observer no-support predictions",
    )
    dataset.add_argument(
        "--unverified-no-support-confidence",
        type=float,
        default=0.25,
    )
    dataset.add_argument(
        "--require-saved-images",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="include only records with at least one image file present on disk",
    )

    evolve = sub.add_parser(
        "self-evolve",
        help="Self-evolving prompting: learn a preference memory from records (no weight updates)",
    )
    evolve_input = evolve.add_mutually_exclusive_group(required=True)
    evolve_input.add_argument(
        "--records-root",
        help="raw Coco records to label before self-evolving",
    )
    evolve_input.add_argument(
        "--labeled",
        help="preselected labeled moments JSONL (for example, a privacy-reviewed subset)",
    )
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
    evolve.add_argument("--seed", type=int, default=42)
    evolve.add_argument(
        "--correct-sample-rate",
        type=_unit_float,
        default=0.5,
        help=(
            "fraction of originally correct examples to retain; errors, unknown "
            "predictions, and adjacent correct anchors are always retained"
        ),
    )
    evolve.add_argument(
        "--shuffle",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="shuffle examples each epoch instead of preserving chronological order",
    )
    evolve.add_argument(
        "--resume",
        action="store_true",
        help="resume from the last completed batch in --out-dir",
    )

    args = parser.parse_args(argv)
    if args.cmd == "summary":
        return _cmd_summary(args)
    if args.cmd == "label":
        return _cmd_label(args)
    if args.cmd == "revise-labels":
        return _cmd_revise_labels(args)
    if args.cmd == "build-dataset":
        return _cmd_build_dataset(args)
    if args.cmd == "self-evolve":
        return _cmd_self_evolve(args)
    parser.error(f"unknown command: {args.cmd}")
    return 2


def _load_flat_records(records_root: str):
    sessions = load_records(records_root)
    return sessions, flatten_sessions(sessions)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _unit_float(value: str) -> float:
    parsed = float(value)
    if not 0.0 <= parsed <= 1.0:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return parsed


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
    sessions, records = _load_flat_records(args.records_root)
    cutoff = (
        time.time() - args.last_days * 24 * 60 * 60
        if args.last_days is not None
        else None
    )
    retrospective_signals = (
        derive_retrospective_signals(
            sessions,
            model=args.retrospective_model,
            min_confidence=args.retrospective_min_confidence,
            candidate_since_ts=cutoff,
            show_progress=args.show_progress,
            max_observations=args.retrospective_max_observations,
            trigger_max_observations=(args.retrospective_trigger_max_observations),
            max_opportunities=args.retrospective_max_opportunities,
            trace_out=args.retrospective_trace_out,
        )
        if args.retrospective_model
        else []
    )
    labeled = label_records(
        records,
        min_abs_score=args.min_abs_score,
        include_unverified_no_support=args.include_unverified_no_support,
        unverified_no_support_confidence=args.unverified_no_support_confidence,
        require_saved_images=args.require_saved_images,
        additional_signals=retrospective_signals,
    )
    if cutoff is not None:
        labeled = [moment for moment in labeled if moment.ts >= cutoff]
    write_labeled_moments(args.out, labeled)
    print(
        f"wrote {len(labeled)} labeled moments to {args.out} "
        f"(retrospective signals={len(retrospective_signals)})",
        file=sys.stderr,
    )
    return 0


def _cmd_revise_labels(args) -> int:
    _, records = _load_flat_records(args.records_root)
    labeled = read_labeled_moments(args.labeled)
    revised, eligible = revise_label_disagreements(
        records,
        labeled,
        model=args.revision_model,
        limit=args.limit,
        concurrency=args.concurrency,
        retries=args.revision_retries,
        show_progress=True,
    )
    write_labeled_moments(args.out, revised)
    print(
        f"eligible disagreements={eligible}; wrote revised sample={len(revised)} "
        f"to {args.out}",
        file=sys.stderr,
    )
    return 0


def _cmd_build_dataset(args) -> int:
    _, records = _load_flat_records(args.records_root)
    labeled = [
        moment
        for moment in label_records(
            records,
            include_unverified_no_support=args.include_unverified_no_support,
            unverified_no_support_confidence=args.unverified_no_support_confidence,
            require_saved_images=args.require_saved_images,
        )
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
    yes_count = sum(moment.need_support == "yes" for moment in labeled)
    no_count = sum(moment.need_support == "no" for moment in labeled)
    print(
        f"wrote train={len(train_examples)} eval={len(eval_examples)} examples "
        f"(need_support yes={yes_count} no={no_count}) to {out_dir}",
        file=sys.stderr,
    )
    return 0


def _cmd_self_evolve(args) -> int:
    if args.labeled:
        all_labeled = read_labeled_moments(args.labeled)
        input_counts = {
            "input": "labeled",
            "labeled_path": str(Path(args.labeled).expanduser()),
            "labeled_moments": len(all_labeled),
        }
    else:
        _, records = _load_flat_records(args.records_root)
        signals = derive_short_window_signals(records)
        all_labeled = label_records(records)
        input_counts = {
            "input": "records",
            "records_root": str(Path(args.records_root).expanduser()),
            "observations": len(records.observations),
            "feedback_events": len(records.feedback),
            "tutor_calls": len(records.tutor_calls),
            "decisions": len(records.decisions),
            "short_window_signals": len(signals),
            "labeled_moments": len(all_labeled),
        }
    confidence_filtered = [
        moment
        for moment in all_labeled
        if moment.label_confidence >= args.min_confidence
    ]
    selection = select_evolution_moments(
        confidence_filtered,
        correct_sample_rate=args.correct_sample_rate,
        seed=args.seed,
    )
    labeled = selection.moments
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
                    **input_counts,
                    "samples_after_confidence_filter": len(confidence_filtered),
                    "original_disagreements_retained": selection.original_disagreements,
                    "unknown_original_predictions_retained": (
                        selection.unknown_original_predictions
                    ),
                    "correct_samples_available": selection.correct_available,
                    "correct_samples_retained": selection.correct_retained,
                    "adjacent_correct_anchors_retained": (
                        selection.adjacent_correct_anchors
                    ),
                    "samples_feeding_self_evolving_prompting": len(labeled),
                    "min_confidence": args.min_confidence,
                    "correct_sample_rate": args.correct_sample_rate,
                    "shuffle": args.shuffle,
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
            seed=args.seed,
            shuffle=args.shuffle,
        ),
    )
    out_dir = Path(args.out_dir).expanduser()
    learner.learn(labeled, out_dir=out_dir, resume=args.resume)

    # Promote the inferred insights into an approvable MemoryDraft so a human can
    # review before they ever influence the live layered prompt context.
    if args.memory_root:
        store = MemoryStore(args.memory_root)
        draft = create_memory_draft(
            source_run_id=f"self-evolve:{args.persona or 'default'}",
            based_on_user_memory=store.load_user_memory(),
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
