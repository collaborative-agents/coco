"""Sectioned bullet memory with Grow-and-Refine mechanics.

The local state transitions of the self-evolving loop: apply curator delta ops
(add / update / delete), vote helpful/harmful, refine (drop lowest-utility
bullets over the cap), and export draft learned preferences.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from personalization.memory.prompts import SECTION_TITLES, SECTIONS
from personalization.schemas import JsonDict, LearnedPreference, stable_id


@dataclass(slots=True)
class MemoryBullet:
    id: str
    section: str
    content: str
    helpful: int = 0
    harmful: int = 0
    born: int = 0
    evidence_moment_ids: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0

    def utility(self) -> float:
        return self.helpful - self.harmful


@dataclass(slots=True)
class MemoryOp:
    op: str
    section: str | None = None
    content: str | None = None
    id: str | None = None
    evidence_moment_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, row: JsonDict) -> MemoryOp:
        return cls(
            op=str(row.get("op", "")),
            section=str(row.get("section")) if row.get("section") else None,
            content=str(row.get("content")) if row.get("content") else None,
            id=str(row.get("id")) if row.get("id") else None,
            evidence_moment_ids=[
                str(item)
                for item in row.get("evidence_moment_ids", [])
                if item is not None
            ]
            if isinstance(row.get("evidence_moment_ids"), list)
            else [],
        )


class SectionedMemory:
    """Sectioned bullet memory with helpful/harmful counters and delta ops."""

    def __init__(self, bullets: dict[str, MemoryBullet] | None = None) -> None:
        self.bullets = bullets or {}
        self._next = _next_id_number(self.bullets)
        self._age = max((b.born for b in self.bullets.values()), default=0)

    def apply_ops(self, ops: list[MemoryOp | JsonDict], *, max_ops: int = 8) -> int:
        applied = 0
        for raw_op in ops[:max_ops]:
            op = raw_op if isinstance(raw_op, MemoryOp) else MemoryOp.from_dict(raw_op)
            if op.op == "add":
                if self._add(op):
                    applied += 1
            elif op.op == "update":
                if self._update(op):
                    applied += 1
            elif op.op == "delete":
                if op.id in self.bullets:
                    del self.bullets[op.id]
                    applied += 1
        return applied

    def _add(self, op: MemoryOp) -> bool:
        content = (op.content or "").strip()
        if not content or self._is_duplicate(content):
            return False
        section = op.section if op.section in SECTIONS else "general"
        self._age += 1
        now = time.time()
        bid = f"m-{self._next:03d}"
        self._next += 1
        self.bullets[bid] = MemoryBullet(
            id=bid,
            section=section,
            content=content,
            born=self._age,
            evidence_moment_ids=list(op.evidence_moment_ids),
            created_at=now,
            updated_at=now,
        )
        return True

    def _update(self, op: MemoryOp) -> bool:
        if not op.id or op.id not in self.bullets:
            return False
        content = (op.content or "").strip()
        if not content:
            return False
        bullet = self.bullets[op.id]
        bullet.content = content
        bullet.updated_at = time.time()
        bullet.evidence_moment_ids = sorted(
            set(bullet.evidence_moment_ids) | set(op.evidence_moment_ids)
        )
        return True

    def vote(self, helpful_ids: list[str], harmful_ids: list[str]) -> None:
        for bid in helpful_ids:
            if bid in self.bullets:
                self.bullets[bid].helpful += 1
                self.bullets[bid].updated_at = time.time()
        for bid in harmful_ids:
            if bid in self.bullets:
                self.bullets[bid].harmful += 1
                self.bullets[bid].updated_at = time.time()

    def refine(self, *, max_bullets: int = 60) -> int:
        """Drop lowest-utility bullets (harmful-heavy first, then oldest) over the cap."""
        n_drop = len(self.bullets) - max_bullets
        if n_drop <= 0:
            return 0
        ranked = sorted(
            self.bullets.values(),
            key=lambda b: (b.utility(), b.helpful, -b.born),
        )
        for bullet in ranked[:n_drop]:
            del self.bullets[bullet.id]
        return n_drop

    def mark_stale(
        self,
        *,
        harmful_margin: int = 2,
        min_harmful: int = 2,
    ) -> list[str]:
        stale: list[str] = []
        for bullet in self.bullets.values():
            if (
                bullet.harmful >= min_harmful
                and bullet.harmful - bullet.helpful >= harmful_margin
            ):
                stale.append(bullet.id)
        return stale

    def render(self, *, with_ids: bool = True) -> str:
        if not self.bullets:
            return "(no entries yet — you have not learned anything about this user so far)"
        lines: list[str] = []
        for section in SECTIONS:
            items = [b for b in self.bullets.values() if b.section == section]
            if not items:
                continue
            lines.append(f"## {SECTION_TITLES[section]}")
            for bullet in sorted(items, key=lambda b: b.born):
                prefix = f"[{bullet.id}] " if with_ids else ""
                lines.append(f"- {prefix}{bullet.content}")
            lines.append("")
        return "\n".join(lines).strip()

    def to_json(self) -> JsonDict:
        return {
            "next": self._next,
            "age": self._age,
            "bullets": {
                bid: {
                    "id": bullet.id,
                    "section": bullet.section,
                    "content": bullet.content,
                    "helpful": bullet.helpful,
                    "harmful": bullet.harmful,
                    "born": bullet.born,
                    "evidence_moment_ids": bullet.evidence_moment_ids,
                    "created_at": bullet.created_at,
                    "updated_at": bullet.updated_at,
                }
                for bid, bullet in self.bullets.items()
            },
        }

    @classmethod
    def from_json(cls, data: JsonDict) -> SectionedMemory:
        raw_bullets = data.get("bullets", {})
        bullets: dict[str, MemoryBullet] = {}
        if isinstance(raw_bullets, dict):
            for bid, raw in raw_bullets.items():
                if not isinstance(raw, dict):
                    continue
                try:
                    bullet = MemoryBullet(**raw)
                except TypeError:
                    continue
                bullets[str(bid)] = bullet
        memory = cls(bullets)
        if isinstance(data.get("next"), int):
            memory._next = int(data["next"])
        if isinstance(data.get("age"), int):
            memory._age = int(data["age"])
        return memory

    def to_learned_preferences(
        self, *, status: str = "draft"
    ) -> list[LearnedPreference]:
        prefs: list[LearnedPreference] = []
        for bullet in self.bullets.values():
            confidence = _confidence_from_votes(bullet.helpful, bullet.harmful)
            prefs.append(
                LearnedPreference(
                    id=stable_id("lp", bullet.section, bullet.content),
                    section=bullet.section,
                    content=bullet.content,
                    confidence=confidence,
                    helpful=bullet.helpful,
                    harmful=bullet.harmful,
                    created_at=bullet.created_at,
                    updated_at=bullet.updated_at,
                    last_evidence_at=bullet.updated_at or bullet.created_at,
                    status=status,
                    evidence_moment_ids=list(bullet.evidence_moment_ids),
                )
            )
        return prefs

    def _is_duplicate(self, content: str) -> bool:
        norm = _normalize_content(content)
        return any(_normalize_content(b.content) == norm for b in self.bullets.values())


def _normalize_content(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def _next_id_number(bullets: dict[str, MemoryBullet]) -> int:
    max_n = 0
    for bid in bullets:
        match = re.match(r"m-(\d+)$", bid)
        if match:
            max_n = max(max_n, int(match.group(1)))
    return max_n + 1


def _confidence_from_votes(helpful: int, harmful: int) -> float:
    total = helpful + harmful
    if total == 0:
        return 0.5
    return round(max(0.05, min(0.95, helpful / total)), 4)


def ops_from_json(value: Any) -> list[MemoryOp]:
    """Parse curator output shaped as ``{"ops": [...]}`` or ``[...]``."""
    items = value.get("ops") if isinstance(value, dict) else value
    if not isinstance(items, list):
        return []
    return [MemoryOp.from_dict(item) for item in items if isinstance(item, dict)]
