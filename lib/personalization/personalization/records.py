"""Load Coco's append-only personalization records."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, TypeVar

from personalization.schemas import (
    DecisionRecord,
    FeedbackEvent,
    JsonDict,
    ObservationRecord,
    SessionRecords,
    TutorCallRecord,
)

T = TypeVar("T")


def read_jsonl(path: str | Path) -> list[JsonDict]:
    """Read a JSONL file, skipping blank and malformed lines."""
    p = Path(path).expanduser()
    try:
        text = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    rows: list[JsonDict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def _parse_rows(rows: Iterable[JsonDict], parser: Callable[[JsonDict], T]) -> list[T]:
    out: list[T] = []
    for row in rows:
        try:
            out.append(parser(row))
        except (TypeError, ValueError, KeyError):
            continue
    return out


def discover_session_dirs(root: str | Path) -> list[Path]:
    """Return session-like directories under ``root``.

    ``root`` may be:
    - one concrete session directory containing JSONL files;
    - a ``coco-records`` parent containing ``session_*`` children;
    - an Electron userData directory containing ``coco-records/session_*``.
    """
    base = Path(root).expanduser()
    candidates: list[Path] = []
    if not base.exists():
        return []

    if _looks_like_session_dir(base):
        candidates.append(base)

    for child in sorted(base.glob("session_*")):
        if child.is_dir() and _looks_like_session_dir(child):
            candidates.append(child)

    nested = base / "coco-records"
    if nested.is_dir():
        for child in sorted(nested.glob("session_*")):
            if child.is_dir() and _looks_like_session_dir(child):
                candidates.append(child)
        if _looks_like_session_dir(nested):
            candidates.append(nested)

    # Stable de-duplication while preserving discovery order.
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(path)
    return unique


def _looks_like_session_dir(path: Path) -> bool:
    return any(
        (path / name).is_file()
        for name in (
            "observations.jsonl",
            "feedback.jsonl",
            "tutor_calls.jsonl",
            "decisions.jsonl",
        )
    )


def load_session_records(path: str | Path) -> SessionRecords:
    """Load all known record streams from one session directory."""
    base = Path(path).expanduser()
    observations = sorted(
        _parse_rows(
            read_jsonl(base / "observations.jsonl"),
            ObservationRecord.from_dict,
        ),
        key=lambda r: r.ts,
    )
    _attach_retained_observer_screenshots(base, observations)
    tutor_calls = sorted(
        _parse_rows(
            read_jsonl(base / "tutor_calls.jsonl"),
            TutorCallRecord.from_dict,
        ),
        key=lambda r: r.ts,
    )
    _backfill_tutor_call_session_ids(observations, tutor_calls)
    return SessionRecords(
        path=str(base),
        observations=observations,
        feedback=sorted(
            _parse_rows(read_jsonl(base / "feedback.jsonl"), FeedbackEvent.from_dict),
            key=lambda r: r.ts,
        ),
        tutor_calls=tutor_calls,
        decisions=sorted(
            _parse_rows(read_jsonl(base / "decisions.jsonl"), DecisionRecord.from_dict),
            key=lambda r: r.ts,
        ),
    )


def _backfill_tutor_call_session_ids(
    observations: list[ObservationRecord],
    tutor_calls: list[TutorCallRecord],
    *,
    user_prompt_window_s: float = 60.0,
) -> None:
    """Repair legacy user-prompt calls whose recorder wrote a null session ID.

    Old tutor records were written to the same per-run directory as observations,
    but always used ``session_id=null``. Attribute each such call to the most
    recent non-null observation in the request's look-back window, preferring the
    explicit ``user_prompt`` observation emitted by older sensing builds.
    """
    for call in tutor_calls:
        if call.session_id is not None or call.trigger != "user_prompt":
            continue
        candidates = [
            observation
            for observation in observations
            if observation.session_id is not None
            and call.follows_observation(
                observation.ts,
                window_s=user_prompt_window_s,
            )
        ]
        if not candidates:
            continue
        prompted = [
            observation
            for observation in candidates
            if observation.type == "user_prompt"
        ]
        call.session_id = max(
            prompted or candidates, key=lambda observation: observation.ts
        ).session_id


def _attach_retained_observer_screenshots(
    session_dir: Path,
    observations: list[ObservationRecord],
) -> None:
    """Backfill retained screenshot paths from ``observer_screenshots``.

    Older or partially written ``observations.jsonl`` rows may point at rolling
    ``screenshot_paths`` that have since been deleted. When screenshot retention
    was enabled, ``TrainingRecorder`` copied the actual observer inputs into
    ``observer_screenshots/{observation_id}_{i}.*``. Attach those files as
    ``retained_screenshots`` so downstream inspection and dataset export use the
    stable copies automatically.
    """
    shot_dir = session_dir / "observer_screenshots"
    if not shot_dir.is_dir():
        return

    for obs in observations:
        if not obs.observation_id:
            continue
        retained = [Path(path).expanduser() for path in obs.retained_screenshots]
        existing_retained = [path for path in retained if path.is_file()]
        matches = sorted(
            path for path in shot_dir.glob(f"{obs.observation_id}_*") if path.is_file()
        )
        merged = _dedupe_paths([*existing_retained, *matches])
        if merged:
            obs.retained_screenshots = [str(path) for path in merged]


def _dedupe_paths(paths: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        key = path.resolve() if path.exists() else path
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def load_records(root: str | Path) -> list[SessionRecords]:
    """Discover and load all session records under ``root``."""
    return [load_session_records(path) for path in discover_session_dirs(root)]


def write_json(path: str | Path, data: Any) -> None:
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")


def write_jsonl(path: str | Path, rows: Iterable[JsonDict]) -> None:
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, default=str) + "\n")


def flatten_sessions(records: Iterable[SessionRecords]) -> SessionRecords:
    """Merge loaded sessions into one synthetic records object."""
    observations: list[ObservationRecord] = []
    feedback: list[FeedbackEvent] = []
    tutor_calls: list[TutorCallRecord] = []
    decisions: list[DecisionRecord] = []
    paths: list[str] = []
    for session in records:
        paths.append(session.path)
        observations.extend(session.observations)
        feedback.extend(session.feedback)
        tutor_calls.extend(session.tutor_calls)
        decisions.extend(session.decisions)
    return SessionRecords(
        path=";".join(paths),
        observations=sorted(observations, key=lambda r: r.ts),
        feedback=sorted(feedback, key=lambda r: r.ts),
        tutor_calls=sorted(tutor_calls, key=lambda r: r.ts),
        decisions=sorted(decisions, key=lambda r: r.ts),
    )
