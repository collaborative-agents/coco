"""Shared helpers for consuming model responses."""

from __future__ import annotations

import json
import re
from typing import Any

from personalization.schemas import JsonDict

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_json_object(text: str) -> JsonDict | None:
    """Extract the first JSON object from model text."""
    if not text:
        return None
    candidates: list[str] = []
    fence = _JSON_FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1))
    brace = _JSON_OBJ_RE.search(text)
    if brace:
        candidates.append(brace.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def response_text(response: Any) -> str:
    """Return text from the shared external-api response shape."""
    content = response.content
    if isinstance(content, str):
        return content
    first = content[0] if content else None
    if isinstance(first, str):
        return first
    return str(getattr(first, "text", "") or "")
