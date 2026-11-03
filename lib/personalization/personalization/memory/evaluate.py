"""Evaluate a memory prompt against labeled personalization moments."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from personalization.memory.roles import generate
from personalization.schemas import LabeledMoment


def evaluate_memory_accuracy(
    model: str,
    moments: list[LabeledMoment],
    memory_text: str,
    *,
    image_root: str | Path | None = None,
    max_images: int = 1,
    max_tokens: int = 4096,
    concurrency: int = 4,
) -> dict:
    """Run the generator on fixed moments and summarize need-support accuracy."""
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(
            pool.map(
                lambda moment: generate(
                    model,
                    moment,
                    memory_text,
                    image_root=image_root,
                    max_images=max_images,
                    max_tokens=max_tokens,
                ),
                moments,
            )
        )
    correct = sum(result["correct"] for result in results)
    total = len(results)
    valid = [result for result in results if result["pred"] in ("yes", "no")]
    true_positive = sum(
        result["pred"] == "yes" and result["gt"] == "yes" for result in valid
    )
    false_positive = sum(
        result["pred"] == "yes" and result["gt"] == "no" for result in valid
    )
    false_negative = sum(
        result["pred"] == "no" and result["gt"] == "yes" for result in valid
    )
    true_negative = sum(
        result["pred"] == "no" and result["gt"] == "no" for result in valid
    )
    precision = _safe_ratio(true_positive, true_positive + false_positive)
    recall = _safe_ratio(true_positive, true_positive + false_negative)
    return {
        "accuracy": round(correct / total, 4) if total else 0.0,
        "precision": precision,
        "recall": recall,
        "f1": _safe_ratio(2 * precision * recall, precision + recall),
        "false_alarm_rate": _safe_ratio(false_positive, false_positive + true_negative),
        "correct": correct,
        "total": total,
        "valid_predictions": len(valid),
        "invalid_predictions": total - len(valid),
        "confusion_matrix": {
            "true_positive": true_positive,
            "false_positive": false_positive,
            "false_negative": false_negative,
            "true_negative": true_negative,
        },
    }


def _safe_ratio(numerator: float, denominator: float) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0
