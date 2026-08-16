"""Persistence helpers for layered personalization memory."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from personalization.schemas import (
    JsonDict,
    LearnedPreference,
    MemoryDraft,
    stable_id,
)

MEMORY_DRAFTS_DIR = "memory_drafts"


def _memory_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class MemoryStore:
    """Read user memory and write learned-memory drafts.

    ``user_memory_path`` should usually point at Coco's existing
    ``coco-memory.txt``. Inferred memory is written only as a draft and never
    overwrites user-authored memory.
    """

    def __init__(
        self,
        root: str | Path,
        *,
        user_memory_path: str | Path | None = None,
    ) -> None:
        self.root = Path(root).expanduser()
        self.user_memory_path = (
            Path(user_memory_path).expanduser()
            if user_memory_path is not None
            else self.root / "coco-memory.txt"
        )
        self.drafts_dir = self.root / MEMORY_DRAFTS_DIR

    def load_user_memory(self) -> str:
        try:
            return self.user_memory_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def save_draft(self, draft: MemoryDraft) -> Path:
        path = self.drafts_dir / draft.draft_id / "memory_draft.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(draft.to_dict(), indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        (path.parent / "memory_draft.md").write_text(
            _render_learned_preferences(draft.bullets) + "\n",
            encoding="utf-8",
        )
        return path


def _render_learned_preferences(preferences: list[LearnedPreference]) -> str:
    if not preferences:
        return "(no learned preferences yet)"

    sections = [
        "when_to_support",
        "when_to_stay_silent",
        "how_to_support",
        "tool_preferences",
        "recurring_tasks",
        "general",
    ]
    titles = {
        "when_to_support": "When to proactively support",
        "when_to_stay_silent": "When to stay silent",
        "how_to_support": "How to support",
        "tool_preferences": "Tool preferences",
        "recurring_tasks": "Recurring tasks",
        "general": "General",
    }
    lines: list[str] = []
    for section in sections:
        items = [pref for pref in preferences if pref.section == section]
        if not items:
            continue
        lines.append(f"## {titles[section]}")
        for pref in sorted(items, key=lambda p: p.created_at):
            suffix = f" [{pref.status}, confidence={pref.confidence:.2f}]"
            lines.append(f"- {pref.content}{suffix}")
        lines.append("")
    return "\n".join(lines).strip()


def create_memory_draft(
    *,
    source_run_id: str,
    based_on_user_memory: str,
    bullets: list[LearnedPreference],
    summary: str = "",
    metrics: JsonDict | None = None,
) -> MemoryDraft:
    now = time.time()
    return MemoryDraft(
        draft_id=stable_id("draft", source_run_id, now),
        created_at=now,
        source_run_id=source_run_id,
        based_on_memory_hash=_memory_hash(based_on_user_memory),
        bullets=bullets,
        summary=summary,
        metrics=metrics or {},
    )
