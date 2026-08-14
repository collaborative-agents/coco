"""Signals derived from explicit user feedback events."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from personalization.schemas import FeedbackEvent, ShortWindowSignal, stable_id

# Default lifetime for short-window personalization signals derived from user
# feedback.
#
# These signals are meant to steer the current task/session, not become durable
# memory. Thirty minutes is long enough to prevent obvious repeats after a user
# dismisses or accepts help, while short enough that a stale reaction from an
# earlier task should not keep steering the observer. Long-term preference
# changes should be promoted through learned preferences instead of extending
# this TTL.
DEFAULT_SIGNAL_TTL_S = 30 * 60


# Canonical interpretation of explicit UI feedback for both runtime prompt
# signals and offline support labels.
#
# - ``polarity`` says whether this event argues that Coco should have helped
#   here ("positive"), should have stayed quiet ("negative"), or should only be
#   kept as provenance ("neutral").
# - ``confidence`` is the strength of the short-window signal before downstream
#   weighting. Direct user actions are intentionally strongest; ratings are
#   slightly lower because they often judge the generated help, not only the
#   decision to interrupt.
# - ``scope`` controls how broadly the runtime prompt should apply the signal:
#   "observation" is tied to one moment, "task" should suppress/reinforce
#   nearby similar moments, and "session" can influence the current session's
#   guidance style.
# - ``fallback evidence`` is human-readable text used when the event itself
#   did not carry a richer observation or message body.
# - ``label_weight`` controls this event's contribution to offline support-label
#   resolution; zero retains provenance without changing the label.
@dataclass(frozen=True, slots=True)
class FeedbackPolicy:
    polarity: str
    confidence: float
    scope: str
    fallback_evidence: str
    label_weight: float


FEEDBACK_POLICIES: dict[str, FeedbackPolicy] = {
    "shown": FeedbackPolicy(
        polarity="neutral",
        confidence=0.2,
        scope="observation",
        fallback_evidence="suggestion shown",
        label_weight=0.0,
    ),
    "engage": FeedbackPolicy(
        polarity="positive",
        confidence=1.0,
        scope="observation",
        fallback_evidence="user accepted the proactive suggestion",
        label_weight=1.2,
    ),
    "dismiss": FeedbackPolicy(
        polarity="negative",
        confidence=1.0,
        scope="task",
        fallback_evidence="user dismissed the proactive suggestion",
        label_weight=1.2,
    ),
    "need_help": FeedbackPolicy(
        polarity="positive",
        confidence=1.0,
        scope="observation",
        fallback_evidence="user asked for help despite no suggestion",
        label_weight=1.3,
    ),
    "thumbs_up": FeedbackPolicy(
        polarity="positive",
        confidence=0.9,
        scope="session",
        fallback_evidence="user rated the help positively",
        label_weight=1.0,
    ),
    "thumbs_down": FeedbackPolicy(
        polarity="negative",
        confidence=0.9,
        scope="session",
        fallback_evidence="user rated the help negatively",
        label_weight=1.0,
    ),
}


def feedback_to_short_window_signal(
    event: FeedbackEvent,
    *,
    ttl_s: float = DEFAULT_SIGNAL_TTL_S,
) -> ShortWindowSignal | None:
    """Convert one explicit feedback event into a prompt-context signal."""
    policy = FEEDBACK_POLICIES.get(event.kind)
    if policy is None:
        return None
    evidence = event.text or policy.fallback_evidence
    return ShortWindowSignal(
        signal_id=stable_id(
            "sig",
            event.session_id,
            event.observation_id,
            event.message_id,
            event.ts,
            event.kind,
        ),
        session_id=event.session_id,
        observation_id=event.observation_id,
        ts=event.ts,
        kind=event.kind,
        polarity=policy.polarity,
        scope=policy.scope,
        expires_at=event.ts + ttl_s,
        confidence=policy.confidence,
        evidence=evidence,
        source_record_ids=[
            rid for rid in (event.observation_id, event.message_id) if rid is not None
        ],
    )


def derive_feedback_signals(
    events: Iterable[FeedbackEvent],
    *,
    ttl_s: float = DEFAULT_SIGNAL_TTL_S,
) -> list[ShortWindowSignal]:
    """Convert feedback events into short-window personalization signals."""
    out: list[ShortWindowSignal] = []
    for event in events:
        signal = feedback_to_short_window_signal(event, ttl_s=ttl_s)
        if signal is not None:
            out.append(signal)
    return out
