"""Filesystem-inspired, eager query primitives for proposition memory."""

from __future__ import annotations

import math
import re
import time
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from re import Pattern
from typing import Any, Literal, TypeVar

from memory.models import ObservationRecord, PropositionRecord
from memory.store import MemoryStore

MemoryItem = PropositionRecord | ObservationRecord
SortKey = Literal["score", "time", "confidence"]
TimeField = Literal["observation", "proposition_created", "proposition_updated"]
TimeValue = float | int | str
T = TypeVar("T")

_WORD_RE = re.compile(r"\w+", re.UNICODE)


def pipe(value: T, *commands: Callable[[Any], Any]) -> Any:
    """Eagerly pass ``value`` through each command from left to right.

    Commands are ordinary one-argument callables, so methods whose item list is
    not the first parameter can be adapted with a lambda or ``functools.partial``.

    Example::

        pipe(
            memory.ls("score"),
            lambda items: memory.grep("oauth", items),
            lambda items: memory.bm25("callback failure", items),
        )
    """
    result: Any = value
    for command in commands:
        result = command(result)
    return result


class MemoryFileSystem:
    """Expose a :class:`MemoryStore` through filesystem-like read primitives."""

    def __init__(self, store: MemoryStore):
        self.store = store

    @staticmethod
    def _score(proposition: PropositionRecord, *, now: float | None = None) -> float:
        """Compute a query-independent confidence and durability-aware score."""
        current_time = time.time() if now is None else now
        confidence = max(1, min(10, proposition.confidence or 5)) / 10.0
        durability = max(1, min(10, proposition.decay or 5))
        age_days = max(0.0, (current_time - proposition.updated_at) / 86400)
        half_life_days = 1.0 + (durability - 1) * 40.0
        freshness = math.exp(-math.log(2) * age_days / half_life_days)
        return confidence * freshness

    def ls(self, sort_by: SortKey = "score") -> list[PropositionRecord]:
        """List all propositions, ordered by score, time, or confidence."""
        propositions = self.store.all_propositions()
        if sort_by == "time":
            return sorted(
                propositions,
                key=lambda item: (item.updated_at, item.id),
                reverse=True,
            )
        if sort_by == "confidence":
            return sorted(
                propositions,
                key=lambda item: (
                    item.confidence if item.confidence is not None else -1,
                    item.updated_at,
                    item.id,
                ),
                reverse=True,
            )
        if sort_by != "score":
            raise ValueError("sort_by must be 'score', 'time', or 'confidence'")
        now = time.time()
        return sorted(
            propositions,
            key=lambda item: (self._score(item, now=now), item.updated_at, item.id),
            reverse=True,
        )

    def stat(self, proposition: PropositionRecord) -> dict[str, Any]:
        """Return proposition metadata and its current storage score."""
        observations = self.store.observations_for_proposition(proposition.id)
        return {
            "id": proposition.id,
            "reasoning": proposition.reasoning,
            "confidence": proposition.confidence,
            "durability": proposition.decay,
            "revision_group": proposition.revision_group,
            "version": proposition.version,
            "created_at": proposition.created_at,
            "updated_at": proposition.updated_at,
            "proposition_time": {
                "created_at": _timestamp(proposition.created_at),
                "updated_at": _timestamp(proposition.updated_at),
            },
            "observation_time": _observation_time(observations),
            "score": self._score(proposition),
            "observation_count": len(observations),
        }

    @staticmethod
    def cat(proposition: PropositionRecord) -> str:
        """Return proposition text only."""
        return proposition.text

    def read(
        self, proposition: PropositionRecord
    ) -> tuple[str, list[ObservationRecord]]:
        """Return proposition text and all evidence, newest first."""
        return (
            proposition.text,
            self.store.observations_for_proposition(proposition.id),
        )

    def head(self, proposition: PropositionRecord, k: int) -> list[ObservationRecord]:
        """Return the ``k`` most recent linked observations."""
        self._validate_k(k)
        return self.store.observations_for_proposition(
            proposition.id, newest_first=True, limit=k
        )

    def tail(self, proposition: PropositionRecord, k: int) -> list[ObservationRecord]:
        """Return the ``k`` oldest linked observations."""
        self._validate_k(k)
        return self.store.observations_for_proposition(
            proposition.id, newest_first=False, limit=k
        )

    @staticmethod
    def _validate_k(k: int) -> None:
        if k < 0:
            raise ValueError("k must be non-negative")

    @staticmethod
    def grep(
        pattern: str | Pattern[str],
        items: Iterable[MemoryItem],
        *,
        regex: bool = False,
    ) -> list[MemoryItem]:
        """Match proposition or observation text literally or by regex."""
        if isinstance(pattern, re.Pattern):
            compiled = pattern
        elif regex:
            compiled = re.compile(pattern)
        else:
            needle = pattern.casefold()
            return [item for item in items if needle in _text(item).casefold()]
        return [item for item in items if compiled.search(_text(item))]

    @staticmethod
    def bm25(
        query: str,
        items: Sequence[PropositionRecord],
    ) -> list[PropositionRecord]:
        """Rank the supplied propositions using BM25 over proposition text."""
        documents = list(items)
        query_terms = _terms(query)
        if not query_terms or not documents:
            return documents

        term_counts = [Counter(_terms(item.text)) for item in documents]
        lengths = [sum(counts.values()) for counts in term_counts]
        average_length = sum(lengths) / len(lengths) or 1.0
        document_frequency = {
            term: sum(term in counts for counts in term_counts)
            for term in set(query_terms)
        }
        k1, b = 1.5, 0.75

        def score(index: int) -> float:
            result = 0.0
            counts = term_counts[index]
            for term in query_terms:
                frequency = counts[term]
                if not frequency:
                    continue
                containing = document_frequency[term]
                inverse_document_frequency = math.log(
                    1 + (len(documents) - containing + 0.5) / (containing + 0.5)
                )
                length_normalizer = frequency + k1 * (
                    1 - b + b * lengths[index] / average_length
                )
                result += inverse_document_frequency * (
                    frequency * (k1 + 1) / length_normalizer
                )
            return result

        scored = [(score(index), index, item) for index, item in enumerate(documents)]
        # Like a search command, BM25 omits documents with no matching query term.
        return [
            item
            for item_score, _, item in sorted(
                scored, key=lambda entry: (entry[0], -entry[1]), reverse=True
            )
            if item_score > 0
        ]

    def find(
        self,
        items: Iterable[PropositionRecord],
        time_start: TimeValue | None = None,
        time_end: TimeValue | None = None,
        min_confidence: int | None = None,
        min_durability: int | None = None,
        time_field: TimeField = "observation",
    ) -> list[PropositionRecord]:
        """Filter propositions by time and quality metadata.

        ISO-8601 strings and legacy Unix timestamps are accepted. A date-only
        ``time_end`` includes the full calendar day. Observation time matches a
        proposition when at least one linked observation falls in the range.
        """
        if time_field not in {
            "observation",
            "proposition_created",
            "proposition_updated",
        }:
            raise ValueError(
                "time_field must be 'observation', 'proposition_created', "
                "or 'proposition_updated'"
            )
        start, end = self.normalize_time_range(time_start, time_end)
        if start is not None and end is not None and start > end:
            raise ValueError("time_start must not be later than time_end")

        def in_time_range(item: PropositionRecord) -> bool:
            if start is None and end is None:
                return True
            if time_field == "proposition_created":
                timestamps = [item.created_at]
            elif time_field == "proposition_updated":
                timestamps = [item.updated_at]
            else:
                timestamps = [
                    observation.created_at
                    for observation in self.store.observations_for_proposition(item.id)
                ]
            return any(
                (start is None or timestamp >= start)
                and (end is None or timestamp <= end)
                for timestamp in timestamps
            )

        return [
            item
            for item in items
            if in_time_range(item)
            and (
                min_confidence is None
                or (item.confidence is not None and item.confidence >= min_confidence)
            )
            and (
                min_durability is None
                or (item.decay is not None and item.decay >= min_durability)
            )
        ]

    @staticmethod
    def normalize_time_range(
        time_start: TimeValue | None,
        time_end: TimeValue | None,
    ) -> tuple[float | None, float | None]:
        """Convert ISO-8601 or Unix bounds to inclusive Unix timestamps."""
        return (
            _parse_time_bound(time_start, is_end=False),
            _parse_time_bound(time_end, is_end=True),
        )

    def du(self, proposition: PropositionRecord) -> int:
        """Return the number of observations linked to a proposition."""
        return len(self.store.observations_for_proposition(proposition.id))

    def df(self) -> dict[str, int]:
        """Return aggregate store usage and linkage counts."""
        return self.store.storage_statistics()


def _text(item: MemoryItem) -> str:
    if isinstance(item, PropositionRecord):
        return item.text
    if isinstance(item, ObservationRecord):
        return item.content
    raise TypeError("grep items must be propositions or observations")


def _terms(text: str) -> list[str]:
    return [term.casefold() for term in _WORD_RE.findall(text)]


def _parse_time_bound(value: TimeValue | None, *, is_end: bool) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("time bounds must be ISO-8601 strings or Unix timestamps")
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("time bounds must be ISO-8601 strings or Unix timestamps")

    raw = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            parsed_date = date.fromisoformat(raw)
            parsed = datetime.combine(parsed_date, datetime.min.time(), tzinfo=UTC)
            if is_end:
                parsed += timedelta(days=1)
                return parsed.timestamp() - 1e-6
            return parsed.timestamp()
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid ISO-8601 time bound: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def _timestamp(value: float) -> dict[str, float | str]:
    return {
        "unix": value,
        "iso": datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z"),
    }


def _observation_time(
    observations: Sequence[ObservationRecord],
) -> dict[str, dict[str, float | str] | None]:
    if not observations:
        return {"oldest_at": None, "newest_at": None}
    timestamps = [item.created_at for item in observations]
    return {
        "oldest_at": _timestamp(min(timestamps)),
        "newest_at": _timestamp(max(timestamps)),
    }
