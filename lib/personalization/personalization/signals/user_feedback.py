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


# Canonical interpretation of authoritative feedback for both runtime prompt
# signals and offline support labels. This includes the instant tutor's
# ``abstain`` verdict, which is an automatic negative check on the observer's
# decision to request support. Display and navigation events such as
# ``shown`` and ``need_help`` remain available in raw records for product
# analytics, but are deliberately not direct personalization signals:
#
# - ``engage`` becomes a derived positive ``reveal`` when the same suggestion
#   was not rated down (an explicit thumbs-up takes precedence and avoids
#   double-counting the positive outcome; closing revealed content is benign);
# - asking Coco for help is derived from the surrounding no-intervention moment
#   by ``missed_opportunities`` instead of trusting a UI click in isolation;
# - merely showing a suggestion carries no preference information.
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
    "abstain": FeedbackPolicy(
        polarity="negative",
        confidence=1.0,
        scope="task",
        fallback_evidence=(
            "instant suggestion tutor found no concrete, useful help to offer"
        ),
        label_weight=1.2,
    ),
    "dismiss": FeedbackPolicy(
        polarity="negative",
        confidence=1.0,
        scope="task",
        fallback_evidence="user dismissed the proactive suggestion",
        label_weight=1.2,
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
    """Resolve feedback outcomes into short-window personalization signals."""
    events = list(events)
    grouped: dict[tuple[str | None, str], list[FeedbackEvent]] = {}
    for event in events:
        if event.observation_id is not None:
            grouped.setdefault((event.session_id, event.observation_id), []).append(
                event
            )

    out: list[ShortWindowSignal] = []
    for event in events:
        group = (
            grouped.get((event.session_id, event.observation_id), [])
            if event.observation_id is not None
            else []
        )
        # Closing an already-revealed suggestion is not rejection by itself.
        # A thumbs-down remains authoritative negative feedback for that reveal.
        if event.kind == "dismiss" and any(item.kind == "engage" for item in group):
            continue
        signal = feedback_to_short_window_signal(event, ttl_s=ttl_s)
        if signal is not None:
            out.append(signal)

    for (session_id, observation_id), group in grouped.items():
        kinds = {event.kind for event in group}
        if "engage" not in kinds or "thumbs_down" in kinds or "thumbs_up" in kinds:
            continue
        reveal = max(
            (event for event in group if event.kind == "engage"),
            key=lambda event: event.ts,
        )
        out.append(
            ShortWindowSignal(
                signal_id=stable_id("sig", session_id, observation_id, "reveal"),
                session_id=session_id,
                observation_id=observation_id,
                ts=reveal.ts,
                kind="reveal",
                polarity="positive",
                scope="observation",
                expires_at=reveal.ts + ttl_s,
                confidence=0.8,
                evidence=(
                    reveal.text
                    or "user revealed the proactive suggestion without rating it down"
                ),
                source_record_ids=[
                    rid
                    for rid in (observation_id, reveal.message_id)
                    if rid is not None
                ],
            )
        )
    return out
