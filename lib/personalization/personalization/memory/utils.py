"""Helper functions for self-evolving memory."""

from __future__ import annotations

import json
import re


def parse_json_obj(text: str) -> dict | None:
    """Best-effort extraction of a single JSON object from model output."""
    if not text:
        return None
    candidates = []
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        candidates.append(fence.group(1))
    brace = re.search(r"\{.*\}", text, re.S)
    if brace:
        candidates.append(brace.group(0))
    for candidate in candidates:
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def norm_need(value) -> str | None:
    """Normalize a need_support value to 'yes' / 'no' / None."""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("yes", "y", "true", "1", "support", "need_support"):
        return "yes"
    if text in ("no", "n", "false", "0", "none"):
        return "no"
    return None


def sample_frames(frames: list, max_images: int) -> list:
    """Evenly subsample frames to at most ``max_images`` (0 = keep all)."""
    n = len(frames)
    if max_images <= 0 or n <= max_images:
        return frames
    idxs = sorted({round(i * (n - 1) / (max_images - 1)) for i in range(max_images)})
    return [frames[i] for i in idxs]
