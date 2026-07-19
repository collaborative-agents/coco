"""Core data schemas for Coco personalization.

The schemas are intentionally dependency-light dataclasses. Coco's local JSONL
records are append-only and best-effort, so every ``from_dict`` parser is
permissive: unknown keys are ignored and missing optional values default to
``None`` or an empty container.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import asdict, dataclass, field
from typing import Any

JsonDict = dict[str, Any]


def _as_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _as_str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_str_list(value: Any) -> list[str]:
    return [str(item) for item in _as_list(value)]


def stable_id(prefix: str, *parts: object) -> str:
    """Create a deterministic compact id from stable text parts."""
    raw = "\x1f".join(str(p) for p in parts)
    return f"{prefix}-{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]}"


@dataclass(slots=True)
class ObservationRecord:
    observation_id: str
    session_id: str | None
    ts: float
    type: str
    model: str
    observer_input: str
    observer_output: str
    screenshot_paths: list[str] = field(default_factory=list)
    retained_screenshots: list[str] = field(default_factory=list)
    llm_metrics: JsonDict | None = None

    @classmethod
    def from_dict(cls, row: JsonDict) -> ObservationRecord:
        return cls(
            observation_id=_as_str(row.get("observation_id")),
            session_id=_as_str_or_none(row.get("session_id")),
            ts=_as_float(row.get("ts")),
            type=_as_str(row.get("type"), "unknown"),
            model=_as_str(row.get("model")),
            observer_input=_as_str(row.get("observer_input")),
            observer_output=_as_str(row.get("observer_output")),
            screenshot_paths=_as_str_list(row.get("screenshot_paths")),
            retained_screenshots=_as_str_list(row.get("retained_screenshots")),
            llm_metrics=row.get("llm_metrics")
            if isinstance(row.get("llm_metrics"), dict)
            else None,
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class FeedbackEvent:
    ts: float
    session_id: str | None
    kind: str
    surface: str
    observation_id: str | None = None
    message_id: str | None = None
    status: str | None = None
    latency_s: float | None = None
    text: str | None = None
    extra: JsonDict | None = None

    @classmethod
    def from_dict(cls, row: JsonDict) -> FeedbackEvent:
        latency = row.get("latency_s")
        return cls(
            ts=_as_float(row.get("ts")),
            session_id=_as_str_or_none(row.get("session_id")),
            kind=_as_str(row.get("kind")),
            surface=_as_str(row.get("surface"), "bubble"),
            observation_id=_as_str_or_none(row.get("observation_id")),
            message_id=_as_str_or_none(row.get("message_id")),
            status=_as_str_or_none(row.get("status")),
            latency_s=_as_float(latency) if latency is not None else None,
            text=_as_str_or_none(row.get("text")),
            extra=row.get("extra") if isinstance(row.get("extra"), dict) else None,
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class TutorCallRecord:
    ts: float
    session_id: str | None
    trigger: str
    scenario: str
    model: str
    tutor_input: str
    tutor_output: str
    image_paths: list[str] = field(default_factory=list)
    llm_metrics: JsonDict | None = None

    @classmethod
    def from_dict(cls, row: JsonDict) -> TutorCallRecord:
        return cls(
            ts=_as_float(row.get("ts")),
            session_id=_as_str_or_none(row.get("session_id")),
            trigger=_as_str(row.get("trigger")),
            scenario=_as_str(row.get("scenario")),
            model=_as_str(row.get("model")),
            tutor_input=_as_str(row.get("tutor_input")),
            tutor_output=_as_str(row.get("tutor_output")),
            image_paths=_as_str_list(row.get("image_paths")),
            llm_metrics=row.get("llm_metrics")
            if isinstance(row.get("llm_metrics"), dict)
            else None,
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class DecisionRecord:
    decision_id: str
    session_id: str | None
    ts: float
    scenario: str
    phase: str
    should_intervene: bool | None
    trigger_type: str | None
    confidence: float | None
    evidence: str
    judge_input: str
    fresh_observation_id: str | None = None
    history_observation_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, row: JsonDict) -> DecisionRecord:
        observer = row.get("observer") if isinstance(row.get("observer"), dict) else {}
        confidence = row.get("confidence")
        should_intervene = row.get("should_intervene")
        return cls(
            decision_id=_as_str(row.get("decision_id")),
            session_id=_as_str_or_none(row.get("session_id")),
            ts=_as_float(row.get("ts")),
            scenario=_as_str(row.get("scenario")),
            phase=_as_str(row.get("phase"), "nudge"),
            should_intervene=should_intervene
            if isinstance(should_intervene, bool)
            else None,
            trigger_type=_as_str_or_none(row.get("trigger_type")),
            confidence=_as_float(confidence) if confidence is not None else None,
            evidence=_as_str(row.get("evidence")),
            judge_input=_as_str(row.get("judge_input")),
            fresh_observation_id=_as_str_or_none(observer.get("fresh_observation_id")),
            history_observation_ids=_as_str_list(
                observer.get("history_observation_ids")
            ),
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class SessionRecords:
    path: str
    observations: list[ObservationRecord] = field(default_factory=list)
    feedback: list[FeedbackEvent] = field(default_factory=list)
    tutor_calls: list[TutorCallRecord] = field(default_factory=list)
    decisions: list[DecisionRecord] = field(default_factory=list)


@dataclass(slots=True)
class CandidateMoment:
    moment_id: str
    session_id: str | None
    observation_id: str
    ts: float
    scenario: str | None
    observer_input: str
    observer_output: str
    status: str | None
    image_paths: list[str] = field(default_factory=list)
    retained_image_paths: list[str] = field(default_factory=list)
    preceding_observation_ids: list[str] = field(default_factory=list)
    following_observation_ids: list[str] = field(default_factory=list)
    feedback_events: list[FeedbackEvent] = field(default_factory=list)
    tutor_calls_after: list[TutorCallRecord] = field(default_factory=list)
    decisions: list[DecisionRecord] = field(default_factory=list)

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class LabelSignal:
    signal_id: str
    moment_id: str
    ts: float
    source: str
    polarity: str
    confidence: float
    weight: float
    evidence: str
    source_record_ids: list[str] = field(default_factory=list)

    def signed_score(self) -> float:
        if self.polarity == "positive":
            return self.confidence * self.weight
        if self.polarity == "negative":
            return -self.confidence * self.weight
        return 0.0

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class ShortWindowSignal:
    signal_id: str
    session_id: str | None
    observation_id: str | None
    ts: float
    kind: str
    polarity: str
    scope: str
    expires_at: float
    confidence: float
    evidence: str
    source_record_ids: list[str] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return time.time() < self.expires_at

    def to_label_signal(self, moment_id: str, weight: float = 1.0) -> LabelSignal:
        return LabelSignal(
            signal_id=self.signal_id,
            moment_id=moment_id,
            ts=self.ts,
            source=self.kind,
            polarity=self.polarity,
            confidence=self.confidence,
            weight=weight,
            evidence=self.evidence,
            source_record_ids=list(self.source_record_ids),
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class LabeledMoment:
    moment_id: str
    observation_id: str
    session_id: str | None
    ts: float
    need_support: str
    label_confidence: float
    label_sources: list[str]
    label_rationale: str
    observer_input: str
    observer_output: str
    image_paths: list[str] = field(default_factory=list)
    target_observation: str | None = None
    target_user_intent: str | None = None
    target_suggestion_type: str = "none"
    target_suggestion: str = ""

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class UserMemory:
    memory_id: str
    text: str
    created_at: float
    updated_at: float
    source: str = "user_written"
    active: bool = True
    derived_from_draft_id: str | None = None
    evidence_moment_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_text(cls, text: str, *, now: float | None = None) -> UserMemory:
        ts = time.time() if now is None else now
        return cls(
            memory_id=stable_id("umem", text, ts),
            text=text,
            created_at=ts,
            updated_at=ts,
        )

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class LearnedPreference:
    id: str
    section: str
    content: str
    confidence: float
    helpful: int = 0
    harmful: int = 0
    created_at: float = 0.0
    updated_at: float = 0.0
    last_evidence_at: float = 0.0
    status: str = "draft"
    evidence_moment_ids: list[str] = field(default_factory=list)

    @classmethod
    def new(
        cls,
        *,
        section: str,
        content: str,
        confidence: float = 0.5,
        status: str = "draft",
        evidence_moment_ids: list[str] | None = None,
        now: float | None = None,
    ) -> LearnedPreference:
        ts = time.time() if now is None else now
        return cls(
            id=stable_id("lp", section, content),
            section=section,
            content=content,
            confidence=confidence,
            created_at=ts,
            updated_at=ts,
            last_evidence_at=ts,
            status=status,
            evidence_moment_ids=list(evidence_moment_ids or []),
        )

    def utility(self) -> float:
        return self.helpful - self.harmful + self.confidence

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class MemoryDraft:
    draft_id: str
    created_at: float
    source_run_id: str
    based_on_memory_hash: str | None
    bullets: list[LearnedPreference] = field(default_factory=list)
    summary: str = ""
    metrics: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class SFTExample:
    example_id: str
    split: str
    source_moment_id: str
    messages: list[JsonDict]
    images: list[str] = field(default_factory=list)
    metadata: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return asdict(self)


@dataclass(slots=True)
class PersonalizationRun:
    run_id: str
    created_at: float
    records_root: str
    output_dir: str
    retention_policy: JsonDict = field(default_factory=dict)
    labeling_config: JsonDict = field(default_factory=dict)
    memory_config: JsonDict = field(default_factory=dict)
    dataset_config: JsonDict = field(default_factory=dict)
    counts: JsonDict = field(default_factory=dict)
    artifacts: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return asdict(self)
