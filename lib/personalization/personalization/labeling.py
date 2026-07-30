"""Candidate moment construction and label derivation."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from pathlib import Path
from typing import Any

from external_api.llm import prompt_to_text
from tqdm import tqdm

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
_ORIGINAL_SUPPORT_STATUSES = {
    "stuck",
    "mistake",
    "inefficient",
    "ai_struggle",
    "discernment_opportunity",
}
_ORIGINAL_NO_SUPPORT_STATUSES = {"progress", "observing", "task_complete"}
UNVERIFIED_NO_SUPPORT_SOURCE = "observer:no_support_unverified"

_REVISION_SYSTEM_PROMPT = """\
You correct observation annotations after user behavior has established that the
original proactive-support prediction had the wrong polarity.

Return only a JSON object with exactly these string fields:
{
  "observation": "<revised factual description of the user's current situation>",
  "user_intent": "<the user's immediate goal, in under 15 words>"
}

Treat the derived need_support label as authoritative, but remain grounded in the
provided record. Do not invent screen contents, actions, errors, or goals. If
need_support is "yes", clarify the concrete need or useful assistance opportunity
supported by the record. If it is "no", remove unsupported claims of struggle,
error, or interruption-worthy inefficiency. Do not mention labels, feedback, or
the correction process in either field.

The revised observation and intent may be stored in long-term user memory.
Preserve the concrete, memory-relevant details already visible in the original
screenshot-derived observation, such as application and file names, commands,
error messages, artifacts, workflow state, and what changed over time. Do not
replace necessary screenshot details with a vague summary. Preserve only details
supported by the record, and avoid incidental or sensitive details that are not
needed to understand the user's work.
"""


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


def original_need_support(observer_output: str) -> str | None:
    """Read the observer's original support polarity without using it as a label."""
    obj = parse_json_object(observer_output)
    if not obj:
        return None

    explicit = str(obj.get("need_support") or "").strip().lower()
    if explicit in {"yes", "true"}:
        return "yes"
    if explicit in {"no", "false"}:
        return "no"

    status = str(obj.get("status") or "").strip().lower()
    if status in _ORIGINAL_SUPPORT_STATUSES:
        return "yes"
    if status in _ORIGINAL_NO_SUPPORT_STATUSES:
        return "no"
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
        if signal.observation_id == moment.observation_id and signal.kind not in {
            "search_after",
            "ai_tool_after",
        }:
            weight = _short_window_weight(signal.kind)
            signals.append(signal.to_label_signal(moment.moment_id, weight=weight))

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
    include_unverified_no_support: bool = False,
    unverified_no_support_confidence: float = 0.25,
    require_saved_images: bool = False,
) -> list[LabeledMoment]:
    if not 0.0 <= unverified_no_support_confidence <= 1.0:
        raise ValueError("unverified_no_support_confidence must be between 0 and 1")
    moments = build_candidate_moments(records)
    short_signals = derive_short_window_signals(records)
    labeled: list[LabeledMoment] = []
    for moment in moments:
        if require_saved_images:
            saved_images = _existing_moment_images(moment)
            if not saved_images:
                continue
            moment = replace(
                moment,
                image_paths=[],
                retained_image_paths=saved_images,
            )
        signals = label_signals_for_moment(moment, short_signals)
        label = label_moment(moment, signals, min_abs_score=min_abs_score)
        if (
            label is None
            and include_unverified_no_support
            and not any(
                signal.polarity in {"positive", "negative"} for signal in signals
            )
            and original_need_support(moment.observer_output) == "no"
        ):
            label = _unverified_no_support_label(
                moment,
                confidence=unverified_no_support_confidence,
            )
        if label is not None:
            labeled.append(label)
    return labeled


def _existing_moment_images(moment: CandidateMoment) -> list[str]:
    paths = [
        Path(path).expanduser()
        for path in [*moment.retained_image_paths, *moment.image_paths]
    ]
    output: list[str] = []
    seen: set[Path] = set()
    for path in paths:
        if not path.is_file():
            continue
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        output.append(str(path))
    return output


def _unverified_no_support_label(
    moment: CandidateMoment,
    *,
    confidence: float,
) -> LabeledMoment:
    return LabeledMoment(
        moment_id=moment.moment_id,
        observation_id=moment.observation_id,
        session_id=moment.session_id,
        ts=moment.ts,
        need_support="no",
        label_confidence=round(confidence, 4),
        label_sources=[UNVERIFIED_NO_SUPPORT_SOURCE],
        label_rationale=(
            "Weak negative from the observer's original no-support prediction; "
            "no user correction or qualifying interaction signal was recorded."
        ),
        observer_input=moment.observer_input,
        observer_output=moment.observer_output,
        image_paths=moment.retained_image_paths or moment.image_paths,
        target_observation=observer_observation(moment.observer_output),
        target_user_intent=observer_user_intent(moment.observer_output),
        target_suggestion_type="none",
        target_suggestion="",
    )


def revise_label_disagreements(
    records: SessionRecords,
    labeled: list[LabeledMoment],
    *,
    model: str,
    limit: int | None = None,
    concurrency: int = 8,
    retries: int = 2,
    show_progress: bool = False,
) -> tuple[list[LabeledMoment], int]:
    """Revise labels that disagree with observer predictions.

    Returns only the revised examples plus the total number of eligible
    disagreements, leaving the input label list untouched.
    """
    if not model:
        raise ValueError("model is required")
    if limit is not None and limit < 1:
        raise ValueError("limit must be at least 1")
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    if retries < 0:
        raise ValueError("retries must be at least 0")

    moments_by_id = {
        moment.moment_id: moment for moment in build_candidate_moments(records)
    }
    disagreements: list[tuple[CandidateMoment, LabeledMoment]] = []
    for label in labeled:
        moment = moments_by_id.get(label.moment_id)
        if moment is None:
            continue
        original_prediction = original_need_support(moment.observer_output)
        if (
            original_prediction is not None
            and original_prediction != label.need_support
        ):
            disagreements.append((moment, label))

    selected = disagreements if limit is None else disagreements[:limit]
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _revise_disagreement,
                moment,
                label,
                model=model,
                retries=retries,
            ): index
            for index, (moment, label) in enumerate(selected)
        }
        revised: list[LabeledMoment | None] = [None] * len(selected)
        with tqdm(
            total=len(selected),
            desc="Revising labels",
            unit="label",
            disable=not show_progress,
        ) as progress:
            for future in as_completed(futures):
                revised[futures[future]] = future.result()
                progress.update()
    return [item for item in revised if item is not None], len(disagreements)


def _revise_disagreement(
    moment: CandidateMoment,
    label: LabeledMoment,
    *,
    model: str,
    retries: int,
) -> LabeledMoment:
    original_prediction = original_need_support(moment.observer_output)
    if original_prediction is None or original_prediction == label.need_support:
        raise ValueError("label revision requires a polarity disagreement")

    base_prompt = "\n\n".join(
        (
            f"Original need_support prediction: {original_prediction}",
            f"Derived need_support label: {label.need_support}",
            f"Derived-label rationale:\n{label.label_rationale}",
            f"Original observer input:\n{moment.observer_input}",
            f"Original observer output:\n{moment.observer_output}",
        )
    )
    prompt = base_prompt
    for attempt in range(retries + 1):
        raw = prompt_to_text(
            model=model,
            system_prompt=_REVISION_SYSTEM_PROMPT,
            user_prompt=prompt,
        )
        revised = parse_json_object(raw)
        observation = (
            str(revised.get("observation") or "").strip() if revised is not None else ""
        )
        user_intent = (
            str(revised.get("user_intent") or "").strip() if revised is not None else ""
        )
        if observation and user_intent:
            return replace(
                label,
                target_observation=observation,
                target_user_intent=user_intent,
            )
        if attempt < retries:
            prompt = "\n\n".join(
                (
                    base_prompt,
                    "Your previous response was invalid. Return only one JSON object "
                    'with non-empty string fields "observation" and "user_intent".',
                    f"Invalid previous response:\n{str(raw)[-4000:]}",
                )
            )

    raise ValueError(
        "label revision model returned invalid JSON after "
        f"{retries + 1} attempts; expected non-empty observation and "
        "user_intent strings"
    )
