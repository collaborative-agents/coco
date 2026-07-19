"""Evaluate one saved memory Markdown file with a given model.

Example:
    uv run python lib/personalization/personalization/tests/evaluate_memory_prompt.py \
        --prediction-model nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6 \
        --memory-md /tmp/coco-inferred-memory/inferred_memory.md \
        --records-root "$COCO_PERSONALIZATION_RECORDS_ROOT"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from dotenv import load_dotenv
from personalization.memory import evaluate_memory_accuracy
from personalization.tests.signals_to_memory_prompt import (
    _load_real_records,
    _records_root_from_env,
    _select_signal_backed_moments,
)


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description=(
            "Evaluate one saved memory prompt and report accuracy, precision, "
            "recall, F1, and false alarm rate without evolving or inducing it."
        )
    )
    parser.add_argument(
        "--memory-md",
        "--input",
        dest="memory_md",
        required=True,
        help="Saved memory Markdown to pass verbatim to the generator.",
    )
    parser.add_argument(
        "--prediction-model",
        required=True,
        help="Prediction model routed by external_api.",
    )
    parser.add_argument(
        "--records-root",
        default=_records_root_from_env(),
        help=(
            "Records used to evaluate accuracy. Defaults to "
            "COCO_PERSONALIZATION_RECORDS_ROOT or COCO_RECORDS_ROOT."
        ),
    )
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
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--out", help="Optional path for the JSON report.")
    args = parser.parse_args(argv)

    memory_path = Path(args.memory_md).expanduser()
    if not memory_path.is_file():
        parser.error(f"memory Markdown does not exist: {memory_path}")

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

    result = evaluate_memory_accuracy(
        args.prediction_model,
        moments,
        memory_path.read_text(),
        image_root=args.image_root,
        max_images=args.max_images,
        max_tokens=args.max_tokens,
        concurrency=args.concurrency,
    )
    report = {
        "prediction_model": args.prediction_model,
        "memory_md": str(memory_path),
        **result,
        "evaluation_selection": selection_stats,
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
