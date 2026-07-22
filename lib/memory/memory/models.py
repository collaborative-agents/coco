from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class ObservationInput:
    id: str
    content: str
    created_at: float
    observation_type: str = "unknown"
    session_id: str | None = None
    scenario: str | None = None
    observer_name: str = "ScreenObserver"
    content_type: str = "text"


@dataclass(slots=True, frozen=True)
class ObservationRecord(ObservationInput):
    processed_at: float | None = None


@dataclass(slots=True, frozen=True)
class PropositionDraft:
    text: str
    reasoning: str
    confidence: int | None = None
    decay: int | None = None
    observation_ids: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True)
class PropositionRecord(PropositionDraft):
    id: int = 0
    revision_group: str = ""
    version: int = 1
    created_at: float = 0.0
    updated_at: float = 0.0


@dataclass(slots=True, frozen=True)
class PropositionUpdateRecord:
    id: int
    relation: str
    summary: str
    reasoning: str
    created_at: float
    observation_ids: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True)
class PropositionHit:
    proposition: PropositionRecord
    score: float
    observations: list[ObservationRecord] = field(default_factory=list)
    updates: list[PropositionUpdateRecord] = field(default_factory=list)
