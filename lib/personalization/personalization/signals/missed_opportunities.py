"""Signals for manual support requests after Coco stayed silent."""

from __future__ import annotations

from collections import defaultdict

from personalization.observer_output import original_need_support
from personalization.schemas import (
    DecisionRecord,
    ObservationRecord,
    SessionRecords,
    ShortWindowSignal,
    stable_id,
)
from personalization.signals.user_feedback import DEFAULT_SIGNAL_TTL_S

MISSED_OPPORTUNITY_WINDOW_S = 60


def derive_missed_opportunity_signals(
    records: SessionRecords,
    *,
    window_s: float = MISSED_OPPORTUNITY_WINDOW_S,
    ttl_s: float = DEFAULT_SIGNAL_TTL_S,
) -> list[ShortWindowSignal]:
    """Find no-support decisions followed by a manual request to Coco."""
    out: list[ShortWindowSignal] = []
    observations_by_session: dict[str | None, list[ObservationRecord]] = defaultdict(
        list
    )
    for observation in records.observations:
        observations_by_session[observation.session_id].append(observation)

    tutor_calls_by_session = defaultdict(list)
    for call in records.tutor_calls:
        tutor_calls_by_session[call.session_id].append(call)

    decisions_by_observation: dict[tuple[str | None, str], list[DecisionRecord]] = (
        defaultdict(list)
    )
    for decision in records.decisions:
        if decision.fresh_observation_id:
            key = (decision.session_id, decision.fresh_observation_id)
            decisions_by_observation[key].append(decision)

    for session_id, observations in observations_by_session.items():
        calls = tutor_calls_by_session.get(session_id, [])
        for observation in observations:
            if (
                observation.type != "user_prompt"
                and _no_suggestion_was_emitted(
                    observation.observer_output,
                    decisions_by_observation.get(
                        (observation.session_id, observation.observation_id), []
                    ),
                )
                and any(
                    call.trigger == "user_prompt"
                    and call.follows_observation(observation.ts, window_s=window_s)
                    for call in calls
                )
            ):
                out.append(
                    _missed_opportunity_signal(
                        observation,
                        ttl_s=ttl_s,
                    )
                )

    return out


def _no_suggestion_was_emitted(
    observer_output: str,
    decisions: list[DecisionRecord],
) -> bool:
    """Return true only when the recorded intervention polarity is known to be no."""
    decided = [
        decision for decision in decisions if decision.should_intervene is not None
    ]
    if decided:
        return max(decided, key=lambda decision: decision.ts).should_intervene is False
    return original_need_support(observer_output) == "no"


def _missed_opportunity_signal(
    observation: ObservationRecord,
    *,
    ttl_s: float,
) -> ShortWindowSignal:
    kind = "user_prompt_after"
    return ShortWindowSignal(
        signal_id=stable_id(
            "sig", observation.session_id, observation.observation_id, kind
        ),
        session_id=observation.session_id,
        observation_id=observation.observation_id,
        ts=observation.ts,
        kind=kind,
        polarity="positive",
        scope="observation",
        expires_at=observation.ts + ttl_s,
        confidence=0.85,
        evidence="user asked Coco shortly after this observation",
        source_record_ids=[observation.observation_id],
    )
