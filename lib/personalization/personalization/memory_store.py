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
    UserMemory,
    stable_id,
)

LEARNED_PREFERENCES_FILE = "learned_preferences.json"
MEMORY_DRAFTS_DIR = "memory_drafts"


def memory_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class MemoryStore:
    """Read and write user and learned memory artifacts.

    ``user_memory_path`` should usually point at Coco's existing
    ``coco-memory.txt``. Learned preferences are kept separately so inferred
    memory never overwrites user-authored memory.
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
        self.learned_preferences_path = self.root / LEARNED_PREFERENCES_FILE
        self.drafts_dir = self.root / MEMORY_DRAFTS_DIR

    def load_user_memory(self) -> UserMemory:
        try:
            text = self.user_memory_path.read_text(encoding="utf-8")
            updated = self.user_memory_path.stat().st_mtime
        except FileNotFoundError:
            text = ""
            updated = time.time()
        return UserMemory(
            memory_id=stable_id("umem", str(self.user_memory_path), text),
            text=text,
            created_at=updated,
            updated_at=updated,
        )

    def save_user_memory(self, memory: UserMemory | str) -> UserMemory:
        if isinstance(memory, str):
            current = self.load_user_memory()
            obj = UserMemory(
                memory_id=current.memory_id,
                text=memory,
                created_at=current.created_at,
                updated_at=time.time(),
            )
        else:
            obj = memory
            obj.updated_at = time.time()
        self.user_memory_path.parent.mkdir(parents=True, exist_ok=True)
        self.user_memory_path.write_text(obj.text, encoding="utf-8")
        return obj

    def load_learned_preferences(self) -> list[LearnedPreference]:
        try:
            data = json.loads(self.learned_preferences_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []
        items = data.get("preferences", data) if isinstance(data, dict) else data
        if not isinstance(items, list):
            return []
        out: list[LearnedPreference] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                out.append(LearnedPreference(**item))
            except TypeError:
                continue
        return out

    def save_learned_preferences(self, preferences: list[LearnedPreference]) -> None:
        self.learned_preferences_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "updated_at": time.time(),
            "preferences": [pref.to_dict() for pref in preferences],
        }
        self.learned_preferences_path.write_text(
            json.dumps(payload, indent=2, default=str) + "\n",
            encoding="utf-8",
        )

    def save_draft(self, draft: MemoryDraft) -> Path:
        path = self.drafts_dir / draft.draft_id / "memory_draft.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(draft.to_dict(), indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        (path.parent / "memory_draft.md").write_text(
            render_learned_preferences(draft.bullets, include_status=True) + "\n",
            encoding="utf-8",
        )
        return path

    def approve_draft(
        self,
        draft: MemoryDraft,
        *,
        approved_ids: set[str] | None = None,
    ) -> list[LearnedPreference]:
        """Promote selected draft bullets into active learned preferences."""
        existing = {pref.id: pref for pref in self.load_learned_preferences()}
        ids = approved_ids or {pref.id for pref in draft.bullets}
        now = time.time()
        for pref in draft.bullets:
            if pref.id not in ids:
                continue
            promoted = existing.get(pref.id, pref)
            promoted.status = "active"
            promoted.updated_at = now
            promoted.confidence = max(promoted.confidence, pref.confidence)
            promoted.evidence_moment_ids = sorted(
                set(promoted.evidence_moment_ids) | set(pref.evidence_moment_ids)
            )
            existing[promoted.id] = promoted
        preferences = sorted(existing.values(), key=lambda p: (p.section, p.content))
        self.save_learned_preferences(preferences)
        return preferences


def render_learned_preferences(
    preferences: list[LearnedPreference],
    *,
    include_status: bool = False,
    active_only: bool = False,
) -> str:
    prefs = [
        pref
        for pref in preferences
        if not active_only or pref.status in {"active", "approved"}
    ]
    if not prefs:
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
        items = [pref for pref in prefs if pref.section == section]
        if not items:
            continue
        lines.append(f"## {titles[section]}")
        for pref in sorted(items, key=lambda p: p.created_at):
            suffix = (
                f" [{pref.status}, confidence={pref.confidence:.2f}]"
                if include_status
                else ""
            )
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
        based_on_memory_hash=memory_hash(based_on_user_memory),
        bullets=bullets,
        summary=summary,
        metrics=metrics or {},
    )
