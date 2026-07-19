"""Prompt-context assembly for layered personalization."""

from __future__ import annotations

import time
from collections.abc import Iterable

from personalization.memory_store import render_learned_preferences
from personalization.schemas import LearnedPreference, ShortWindowSignal, UserMemory


def render_personalization_context(
    *,
    user_memory: UserMemory | str | None = None,
    short_window_signals: Iterable[ShortWindowSignal] | None = None,
    learned_preferences: Iterable[LearnedPreference] | None = None,
    now: float | None = None,
) -> str:
    """Render layered personalization with explicit precedence.

    The order is deliberate:
    1. user-written memory;
    2. recent signals;
    3. learned preferences.
    """
    ts = time.time() if now is None else now
    user_text = _user_memory_text(user_memory)
    signals = [
        s
        for s in (short_window_signals or [])
        if s.expires_at > ts and s.polarity != "neutral"
    ]
    learned = [
        p for p in (learned_preferences or []) if p.status in {"active", "approved"}
    ]
    return "\n\n".join(
        [
            _user_memory_block(user_text),
            _recent_signals_block(signals, ts),
            _learned_preferences_block(learned),
        ]
    )


def _user_memory_text(user_memory: UserMemory | str | None) -> str:
    if user_memory is None:
        return ""
    if isinstance(user_memory, str):
        return user_memory
    return user_memory.text if user_memory.active else ""


def _user_memory_block(text: str) -> str:
    return (
        '<user_memory priority="highest">\n'
        "Explicit user-written memory. Treat this as the highest-priority "
        "personalization source and do not override it with inferred preferences.\n"
        f"{text.strip() or '(no user-written memory yet)'}\n"
        "</user_memory>"
    )


def _recent_signals_block(signals: list[ShortWindowSignal], now: float) -> str:
    lines = [
        '<recent_user_signals priority="session_window">',
        "Recent reactions and behavior. Apply only to the current task/session; "
        "these override older learned preferences when they conflict.",
    ]
    if not signals:
        lines.append("(no active recent signals)")
    else:
        for signal in sorted(signals, key=lambda s: s.ts):
            ttl = max(0.0, signal.expires_at - now)
            lines.append(
                f"- {signal.kind} ({signal.polarity}, scope={signal.scope}, "
                f"expires_in={ttl:.0f}s): {signal.evidence}"
            )
    lines.append("</recent_user_signals>")
    return "\n".join(lines)


def _learned_preferences_block(preferences: list[LearnedPreference]) -> str:
    rendered = render_learned_preferences(preferences, active_only=True)
    return (
        '<learned_preferences priority="lower_than_user_memory_and_recent_signals">\n'
        "Long-term inferred preferences. Apply unless contradicted by "
        "user-written memory or recent signals.\n"
        f"{rendered}\n"
        "</learned_preferences>"
    )
