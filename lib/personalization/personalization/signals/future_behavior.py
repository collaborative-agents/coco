"""Signals inferred from user behavior after an observation."""

from __future__ import annotations

import re
from collections import defaultdict

from personalization.schemas import (
    ObservationRecord,
    SessionRecords,
    ShortWindowSignal,
    stable_id,
)
from personalization.signals.user_feedback import DEFAULT_SIGNAL_TTL_S

FUTURE_BEHAVIOR_WINDOW_S = 60

_SEARCH_RE = re.compile(
    r"\b(search|searched|searching|google|bing|duckduckgo|query|look up|lookup)\b",
    re.IGNORECASE,
)
_AI_TOOL_RE = re.compile(
    r"\b(chatgpt|claude|gemini|grok|qwen|copilot|cursor|codex|"
    r"asked ai|asks ai|ai tool|llm|agent)\b",
    re.IGNORECASE,
)


def derive_future_behavior_signals(
    records: SessionRecords,
    *,
    window_s: float = FUTURE_BEHAVIOR_WINDOW_S,
    ttl_s: float = DEFAULT_SIGNAL_TTL_S,
) -> list[ShortWindowSignal]:
    """Infer weak support-needed signals from behavior after an observation.

    These are intentionally lower-confidence than direct feedback. They identify
    likely false negatives: Coco stayed calm, then the user soon searched, asked
    Coco, or asked another AI tool.
    """
    out: list[ShortWindowSignal] = []
    observations_by_session: dict[str | None, list[ObservationRecord]] = defaultdict(
        list
    )
    for obs in records.observations:
        observations_by_session[obs.session_id].append(obs)

    tutor_calls_by_session = defaultdict(list)
    for call in records.tutor_calls:
        tutor_calls_by_session[call.session_id].append(call)

    for session_id, observations in observations_by_session.items():
        calls = tutor_calls_by_session.get(session_id, [])
        for obs in observations:
            end = obs.ts + window_s
            following = [o for o in observations if obs.ts < o.ts <= end]
            following_text = "\n".join(o.observer_output for o in following)

            if any(c.trigger == "user_prompt" and obs.ts < c.ts <= end for c in calls):
                out.append(
                    _future_signal(
                        obs,
                        kind="user_prompt_after",
                        evidence="user asked Coco shortly after this observation",
                        confidence=0.85,
                        ttl_s=ttl_s,
                    )
                )

            if _SEARCH_RE.search(following_text):
                out.append(
                    _future_signal(
                        obs,
                        kind="search_after",
                        evidence="following observations suggest the user searched soon after",
                        confidence=0.55,
                        ttl_s=ttl_s,
                    )
                )

            if _AI_TOOL_RE.search(following_text):
                out.append(
                    _future_signal(
                        obs,
                        kind="ai_tool_after",
                        evidence="following observations suggest the user used or asked an AI tool soon after",
                        confidence=0.6,
                        ttl_s=ttl_s,
                    )
                )
    return out


def _future_signal(
    obs: ObservationRecord,
    *,
    kind: str,
    evidence: str,
    confidence: float,
    ttl_s: float,
) -> ShortWindowSignal:
    return ShortWindowSignal(
        signal_id=stable_id("sig", obs.session_id, obs.observation_id, kind),
        session_id=obs.session_id,
        observation_id=obs.observation_id,
        ts=obs.ts,
        kind=kind,
        polarity="positive",
        scope="observation",
        expires_at=obs.ts + ttl_s,
        confidence=confidence,
        evidence=evidence,
        source_record_ids=[obs.observation_id],
    )
