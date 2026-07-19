"""Retention and privacy helpers for local personalization artifacts."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from personalization.schemas import CandidateMoment


@dataclass(slots=True)
class RetentionPolicy:
    records_days: int = 30
    keep_user_memory: bool = True
    keep_learned_preferences: bool = True
    dry_run: bool = True


@dataclass(slots=True)
class PruneResult:
    cutoff_ts: float
    deleted_files: list[str]
    kept_files: list[str]
    dry_run: bool


def prune_old_files(
    root: str | Path,
    *,
    policy: RetentionPolicy,
    now: float | None = None,
) -> PruneResult:
    """Delete files older than the retention window.

    Defaults to dry-run. The caller must set ``policy.dry_run=False`` to mutate
    disk state.
    """
    base = Path(root).expanduser()
    ts = time.time() if now is None else now
    cutoff = ts - policy.records_days * 24 * 3600
    deleted: list[str] = []
    kept: list[str] = []
    if not base.exists():
        return PruneResult(cutoff, deleted, kept, policy.dry_run)

    for path in sorted(p for p in base.rglob("*") if p.is_file()):
        if _protected(path, policy):
            kept.append(str(path))
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff:
            deleted.append(str(path))
            if not policy.dry_run:
                try:
                    path.unlink()
                except OSError:
                    pass
        else:
            kept.append(str(path))
    return PruneResult(cutoff, deleted, kept, policy.dry_run)


def _protected(path: Path, policy: RetentionPolicy) -> bool:
    if policy.keep_user_memory and path.name == "coco-memory.txt":
        return True
    if policy.keep_learned_preferences and path.name == "learned_preferences.json":
        return True
    return False


def moments_with_available_images(
    moments: list[CandidateMoment],
    *,
    require_retained: bool = True,
) -> list[CandidateMoment]:
    """Keep moments whose referenced screenshots are available on disk."""
    out: list[CandidateMoment] = []
    for moment in moments:
        paths = moment.retained_image_paths if require_retained else moment.image_paths
        if paths and all(Path(path).expanduser().is_file() for path in paths):
            out.append(moment)
    return out
