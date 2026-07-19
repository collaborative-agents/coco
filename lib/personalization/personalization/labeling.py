"""Candidate moment construction and label derivation."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from personalization.schemas import (
    CandidateMoment,
    DecisionRecord,
    JsonDict,
    LabeledMoment,
    LabelSignal,
    SessionRecords,
    ShortWindowSignal,
    stable_id,
)
from personalization.signals import derive_short_window_signals

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)
_SUPPORT_STATUSES = {
    "stuck",
    "mistake",
    "inefficient",
    "ai_struggle",
    "discernment_opportunity",
}


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


def build_candidate_moments(
    records: SessionRecords,
    *,
    context_before: int = 3,
    context_after: int = 3,
    tutor_after_s: float = 5 * 60,
) -> list[CandidateMoment]:
    """Build one candidate assistance moment per observer call."""
    feedback_by_obs = defaultdict(list)
    for event in records.feedback:
        if event.observation_id:
            feedback_by_obs[event.observation_id].append(event)

    decisions_by_obs = _decisions_by_observation(records.decisions)
    observations = sorted(records.observations, key=lambda r: r.ts)
    moments: list[CandidateMoment] = []
    for idx, obs in enumerate(observations):
        if not obs.observation_id:
            continue
        feedback = feedback_by_obs.get(obs.observation_id, [])
        decisions = decisions_by_obs.get(obs.observation_id, [])
        status = _status_from_feedback(feedback) or observer_status(obs.observer_output)
        scenario = _scenario_from_decisions(decisions)
        tutor_after = [
            call
            for call in records.tutor_calls
            if _same_session(obs.session_id, call.session_id)
            and obs.ts <= call.ts <= obs.ts + tutor_after_s
        ]
        preceding = [
            o.observation_id
            for o in observations[max(0, idx - context_before) : idx]
            if o.observation_id
        ]
        following = [
            o.observation_id
            for o in observations[idx + 1 : idx + 1 + context_after]
            if o.observation_id
        ]
        moments.append(
            CandidateMoment(
                moment_id=stable_id("moment", obs.session_id, obs.observation_id),
                session_id=obs.session_id,
                observation_id=obs.observation_id,
                ts=obs.ts,
                scenario=scenario,
                observer_input=obs.observer_input,
                observer_output=obs.observer_output,
                status=status,
                image_paths=list(obs.screenshot_paths),
                retained_image_paths=list(obs.retained_screenshots),
                preceding_observation_ids=preceding,
                following_observation_ids=following,
                feedback_events=list(feedback),
                tutor_calls_after=tutor_after,
                decisions=list(decisions),
            )
        )
    return moments


def _decisions_by_observation(
    decisions: Iterable[DecisionRecord],
) -> dict[str, list[DecisionRecord]]:
    out: dict[str, list[DecisionRecord]] = defaultdict(list)
    for decision in decisions:
        ids = list(decision.history_observation_ids)
        if decision.fresh_observation_id:
            ids.append(decision.fresh_observation_id)
        for observation_id in ids:
            out[observation_id].append(decision)
    return out


def _status_from_feedback(events) -> str | None:
    for event in events:
        if event.status:
            return event.status
    return None


def _scenario_from_decisions(decisions: list[DecisionRecord]) -> str | None:
    for decision in decisions:
        if decision.scenario:
            return decision.scenario
    return None


def _same_session(left: str | None, right: str | None) -> bool:
    return left == right or left is None or right is None


def label_signals_for_moment(
    moment: CandidateMoment,
    short_window_signals: Iterable[ShortWindowSignal],
) -> list[LabelSignal]:
    """Collect signals that apply to ``moment``."""
    signals: list[LabelSignal] = []
    for event in moment.feedback_events:
        label = _feedback_label_signal(moment, event)
        if label is not None:
            signals.append(label)

    for signal in short_window_signals:
        if signal.observation_id == moment.observation_id:
            weight = _short_window_weight(signal.kind)
            signals.append(signal.to_label_signal(moment.moment_id, weight=weight))

    for decision in moment.decisions:
        if decision.should_intervene is True:
            signals.append(
                LabelSignal(
                    signal_id=stable_id(
                        "lsig", moment.moment_id, decision.decision_id, "judge"
                    ),
                    moment_id=moment.moment_id,
                    ts=decision.ts,
                    source="judge_intervene",
                    polarity="positive",
                    confidence=decision.confidence or 0.5,
                    weight=0.45,
                    evidence=decision.evidence,
                    source_record_ids=[decision.decision_id],
                )
            )

    if moment.status in _SUPPORT_STATUSES:
        signals.append(
            LabelSignal(
                signal_id=stable_id("lsig", moment.moment_id, "status"),
                moment_id=moment.moment_id,
                ts=moment.ts,
                source=f"observer_status:{moment.status}",
                polarity="positive",
                confidence=0.45,
                weight=0.5,
                evidence=f"observer classified the moment as {moment.status}",
                source_record_ids=[moment.observation_id],
            )
        )
    elif moment.status in {"progress", "observing"}:
        signals.append(
            LabelSignal(
                signal_id=stable_id("lsig", moment.moment_id, "calm_status"),
                moment_id=moment.moment_id,
                ts=moment.ts,
                source=f"observer_status:{moment.status}",
                polarity="negative",
                confidence=0.25,
                weight=0.25,
                evidence=f"observer classified the moment as {moment.status}",
                source_record_ids=[moment.observation_id],
            )
        )
    return signals


def _feedback_label_signal(moment: CandidateMoment, event: Any) -> LabelSignal | None:
    mapping = {
        "engage": ("positive", 1.0, 1.2, "user accepted the proactive suggestion"),
        "dismiss": ("negative", 1.0, 1.2, "user dismissed the suggestion"),
        "need_help": (
            "positive",
            1.0,
            1.3,
            "user asked for help despite no suggestion",
        ),
        "thumbs_up": ("positive", 0.9, 1.0, "user rated the help positively"),
        "thumbs_down": ("negative", 0.9, 1.0, "user rated the help negatively"),
        "shown": ("neutral", 0.2, 0.0, "suggestion was shown"),
    }
    if event.kind not in mapping:
        return None
    polarity, confidence, weight, fallback = mapping[event.kind]
    return LabelSignal(
        signal_id=stable_id(
            "lsig", moment.moment_id, event.kind, event.ts, event.message_id
        ),
        moment_id=moment.moment_id,
        ts=event.ts,
        source=f"feedback:{event.kind}",
        polarity=polarity,
        confidence=confidence,
        weight=weight,
        evidence=event.text or fallback,
        source_record_ids=[
            rid for rid in (event.observation_id, event.message_id) if rid
        ],
    )


def _short_window_weight(kind: str) -> float:
    return {
        "engage": 1.0,
        "dismiss": 1.0,
        "need_help": 1.1,
        "thumbs_up": 0.85,
        "thumbs_down": 0.85,
        "user_prompt_after": 0.7,
        "search_after": 0.35,
        "ai_tool_after": 0.45,
    }.get(kind, 0.3)


def label_moment(
    moment: CandidateMoment,
    signals: list[LabelSignal],
    *,
    min_abs_score: float = 0.45,
) -> LabeledMoment | None:
    """Resolve a candidate moment into a binary support label."""
    score = sum(signal.signed_score() for signal in signals)
    if abs(score) < min_abs_score:
        return None

    need_support = "yes" if score > 0 else "no"
    max_score = sum(abs(signal.confidence * signal.weight) for signal in signals)
    confidence = min(1.0, abs(score) / max(max_score, 1e-6))
    sources = [signal.source for signal in signals if signal.polarity != "neutral"]
    rationale = _label_rationale(score, signals)
    suggestion = _target_suggestion(moment) if need_support == "yes" else ""
    return LabeledMoment(
        moment_id=moment.moment_id,
        observation_id=moment.observation_id,
        session_id=moment.session_id,
        ts=moment.ts,
        need_support=need_support,
        label_confidence=round(confidence, 4),
        label_sources=sources,
        label_rationale=rationale,
        observer_input=moment.observer_input,
        observer_output=moment.observer_output,
        image_paths=moment.retained_image_paths or moment.image_paths,
        target_observation=observer_observation(moment.observer_output),
        target_user_intent=observer_user_intent(moment.observer_output),
        target_suggestion_type="direct_message" if suggestion else "none",
        target_suggestion=suggestion,
    )


def _label_rationale(score: float, signals: list[LabelSignal]) -> str:
    direction = "positive" if score > 0 else "negative"
    strongest = sorted(
        [s for s in signals if s.polarity == direction],
        key=lambda s: abs(s.signed_score()),
        reverse=True,
    )[:3]
    if not strongest:
        return f"Resolved from aggregate score {score:.3f}."
    evidence = "; ".join(f"{s.source}: {s.evidence}" for s in strongest)
    return f"Resolved as {direction} from {evidence}."


def _target_suggestion(moment: CandidateMoment) -> str:
    for event in moment.feedback_events:
        if event.kind in {"thumbs_up", "engage", "need_help"} and event.text:
            return event.text
    for call in moment.tutor_calls_after:
        if call.tutor_output:
            return call.tutor_output
    return ""


def label_records(
    records: SessionRecords,
    *,
    min_abs_score: float = 0.45,
) -> list[LabeledMoment]:
    moments = build_candidate_moments(records)
    short_signals = derive_short_window_signals(records)
    labeled: list[LabeledMoment] = []
    for moment in moments:
        signals = label_signals_for_moment(moment, short_signals)
        label = label_moment(moment, signals, min_abs_score=min_abs_score)
        if label is not None:
            labeled.append(label)
    return labeled
