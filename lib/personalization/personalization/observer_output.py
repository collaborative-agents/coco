"""Parsing helpers for recorded Observer outputs."""

from __future__ import annotations

from typing import Any

from personalization.llm_io import parse_json_object

_SUPPORT_STATUSES = {
    "stuck",
    "mistake",
    "inefficient",
    "ai_struggle",
    "discernment_opportunity",
}
_NO_SUPPORT_STATUSES = {"progress", "observing", "task_complete"}


def observer_status(observer_output: str) -> str | None:
    obj = parse_json_object(observer_output)
    status = obj.get("status") if obj else None
    return str(status) if status else None


def observer_observation(observer_output: str) -> str:
    obj = parse_json_object(observer_output)
    if obj and obj.get("observation"):
        return str(obj["observation"])
    return observer_output.strip()


def observer_user_intent(observer_output: str) -> str | None:
    obj = parse_json_object(observer_output)
    if obj and obj.get("user_intent"):
        return str(obj["user_intent"])
    return None


def original_need_support(observer_output: str) -> str | None:
    """Read the Observer's original support polarity."""
    obj = parse_json_object(observer_output)
    if not obj:
        return None

    explicit = str(obj.get("need_support") or "").strip().lower()
    if explicit in {"yes", "true"}:
        return "yes"
    if explicit in {"no", "false"}:
        return "no"

    status = str(obj.get("status") or "").strip().lower()
    if status in _SUPPORT_STATUSES:
        return "yes"
    if status in _NO_SUPPORT_STATUSES:
        return "no"
    return None


def normalize_need_support(value: Any) -> str | None:
    """Normalize a support value to ``yes``, ``no``, or ``None``."""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"yes", "y", "true", "1", "support", "need_support"}:
        return "yes"
    if text in {"no", "n", "false", "0", "none"}:
        return "no"
    return None
