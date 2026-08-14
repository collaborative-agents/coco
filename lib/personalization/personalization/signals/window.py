"""Aggregate short-window personalization signals."""

from __future__ import annotations

import time
from collections.abc import Iterable

from personalization.schemas import SessionRecords, ShortWindowSignal
from personalization.signals.missed_opportunities import (
    MISSED_OPPORTUNITY_WINDOW_S,
    derive_missed_opportunity_signals,
)
from personalization.signals.user_feedback import (
    DEFAULT_SIGNAL_TTL_S,
    derive_feedback_signals,
)


def derive_short_window_signals(
    records: SessionRecords,
    *,
    feedback_ttl_s: float = DEFAULT_SIGNAL_TTL_S,
    missed_opportunity_window_s: float = MISSED_OPPORTUNITY_WINDOW_S,
    missed_opportunity_ttl_s: float = DEFAULT_SIGNAL_TTL_S,
) -> list[ShortWindowSignal]:
    """Derive all short-window signals from records."""
    signals = derive_feedback_signals(records.feedback, ttl_s=feedback_ttl_s)
    signals.extend(
        derive_missed_opportunity_signals(
            records,
            window_s=missed_opportunity_window_s,
            ttl_s=missed_opportunity_ttl_s,
        )
    )
    return sorted(signals, key=lambda s: s.ts)


def active_signals(
    signals: Iterable[ShortWindowSignal],
    *,
    now: float | None = None,
) -> list[ShortWindowSignal]:
    """Return signals whose TTL has not expired."""
    ts = time.time() if now is None else now
    return [signal for signal in signals if signal.expires_at > ts]
