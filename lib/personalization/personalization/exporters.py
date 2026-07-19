"""Artifact exporters for personalization outputs."""

from __future__ import annotations

import json
from pathlib import Path

from personalization.records import write_jsonl
from personalization.schemas import LabeledMoment, SFTExample


def write_labeled_moments(path: str | Path, moments: list[LabeledMoment]) -> None:
    write_jsonl(path, [moment.to_dict() for moment in moments])


def write_sft_jsonl(path: str | Path, examples: list[SFTExample]) -> None:
    write_jsonl(path, [example.to_dict() for example in examples])


def write_sharegpt_json(path: str | Path, examples: list[SFTExample]) -> None:
    """Write examples as a ShareGPT-compatible JSON list."""
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "messages": example.messages,
            "images": example.images,
            "metadata": example.metadata,
        }
        for example in examples
    ]
    p.write_text(json.dumps(records, indent=2, default=str) + "\n", encoding="utf-8")
