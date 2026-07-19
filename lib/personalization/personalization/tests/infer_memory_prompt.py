"""Run only final memory inference on an existing evolved Markdown file.

Example:
    uv run python lib/personalization/personalization/tests/infer_memory_prompt.py \
        --prediction-model nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6 \
        --memory-md /tmp/coco-self-evolving-memory/memory.md \
        --records-root "$COCO_PERSONALIZATION_RECORDS_ROOT" \
        --out-dir /tmp/coco-inferred-memory
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv
from personalization.memory import (
    SectionedMemory,
    evaluate_memory_accuracy,
    infer_memory,
)
from personalization.tests.signals_to_memory_prompt import (
    _load_real_records,
    _records_root_from_env,
    _select_signal_backed_moments,
)


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description=(
            "Infer a compact user model from an existing evolved memory.md "
            "and compare classification metrics without rerunning the learning loop."
        )
    )
    parser.add_argument(
        "--memory-md",
        "--input",
        dest="memory_md",
        required=True,
        help="Original sectioned memory.md produced by self-evolution.",
    )
    parser.add_argument(
        "--prediction-model",
        required=True,
        help="Model used for the three prediction evaluations.",
    )
    parser.add_argument(
        "--evolution-model",
        help="Model used to induce the compact memory; defaults to the prediction model.",
    )
    parser.add_argument(
        "--records-root",
        default=_records_root_from_env(),
        help=(
            "Records used to evaluate accuracy. Defaults to "
            "COCO_PERSONALIZATION_RECORDS_ROOT or COCO_RECORDS_ROOT."
        ),
    )
    parser.add_argument(
        "--out-dir",
        required=True,
        help="Directory for inferred_memory.md and inferred_memory_state.json.",
    )
    parser.add_argument("--max-tokens", type=int, default=20480)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Number of signal-backed labeled moments to evaluate. 0 means all.",
    )
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument("--max-images", type=int, default=1)
    parser.add_argument("--image-root")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--gen-max-tokens", type=int, default=4096)
    args = parser.parse_args(argv)

    source_path = Path(args.memory_md).expanduser()
    if not source_path.is_file():
        parser.error(f"memory Markdown does not exist: {source_path}")

    memory = SectionedMemory.from_markdown(source_path.read_text())
    if not memory.bullets:
        parser.error(
            "no evolved bullets found; expected headings such as "
            "'## When to proactively support' followed by top-level bullets"
        )

    try:
        moments, selection_stats = _select_signal_backed_moments(
            _load_real_records(args.records_root),
            start_index=args.start_index,
            limit=args.limit,
            min_confidence=args.min_confidence,
            max_images=args.max_images,
        )
    except ValueError as exc:
        parser.error(str(exc))

    memory.inferred = infer_memory(
        args.evolution_model or args.prediction_model,
        memory,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
    )
    if memory.inferred is None:
        print("inference returned no usable insights", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / "inferred_memory.md"
    state_path = out_dir / "inferred_memory_state.json"
    report_path = out_dir / "inference_evaluation.json"
    md_path.write_text(memory.render(with_ids=False) + "\n")
    state_path.write_text(json.dumps(memory.to_json(), indent=2) + "\n")

    evaluation_options = {
        "image_root": args.image_root,
        "max_images": args.max_images,
        "max_tokens": args.gen_max_tokens,
        "concurrency": args.concurrency,
    }
    evaluations = {}
    memory_variants = {
        "no_memory": SectionedMemory().render(with_ids=False),
        "self_evolved_memory": memory.render_evolved(with_ids=False),
        "induced_memory": memory.render(with_ids=False),
    }
    for name, memory_text in memory_variants.items():
        print(f"evaluating {name} on {len(moments)} moments...", file=sys.stderr)
        evaluations[name] = evaluate_memory_accuracy(
            args.prediction_model,
            moments,
            memory_text,
            **evaluation_options,
        )

    report = {
        "source": str(source_path),
        "prediction_model": args.prediction_model,
        "evolution_model": args.evolution_model or args.prediction_model,
        "evolved_bullets": len(memory.bullets),
        "inferred_insights": len(memory.inferred.insights),
        "evaluation_selection": selection_stats,
        "accuracy_no_memory": evaluations["no_memory"]["accuracy"],
        "accuracy_self_evolved_memory": evaluations["self_evolved_memory"]["accuracy"],
        "accuracy_induced_memory": evaluations["induced_memory"]["accuracy"],
        "evaluation_details": evaluations,
        "inferred_memory_md": str(md_path),
        "inferred_memory_state": str(state_path),
        "evaluation_report": str(report_path),
    }
    for metric in ("precision", "recall", "f1", "false_alarm_rate"):
        for variant, result in evaluations.items():
            report[f"{metric}_{variant}"] = result[metric]
    report_path.write_text(json.dumps(report, indent=2) + "\n")

    print(json.dumps(report, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
