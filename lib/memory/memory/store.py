from __future__ import annotations

import math
import re
import sqlite3
import time
from collections.abc import Iterable
from pathlib import Path
from uuid import uuid4

from memory.models import (
    ObservationInput,
    ObservationRecord,
    PropositionDraft,
    PropositionHit,
    PropositionRecord,
    PropositionUpdateRecord,
)

# FTS5's BM25 scores are negative, with more-negative values ranking higher.
# These multipliers make direct proposition matches strongest while retaining
# updates and raw observations as progressively weaker recall paths.
_PROPOSITION_MATCH_WEIGHT = 4.0
_UPDATE_MATCH_WEIGHT = 2.0
_OBSERVATION_MATCH_WEIGHT = 0.25


def _fts_query(raw: str) -> str:
    tokens = re.findall(r"\w+", raw.lower(), flags=re.UNICODE)
    return " OR ".join(f'"{token}"' for token in tokens[:40])


class MemoryStore:
    """Thread-safe-by-connection SQLite repository for observations/propositions."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def initialize(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY,
                    observer_name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    observation_type TEXT NOT NULL,
                    session_id TEXT,
                    scenario TEXT,
                    created_at REAL NOT NULL,
                    processed_at REAL
                );
                CREATE INDEX IF NOT EXISTS observations_pending_idx
                    ON observations(processed_at, created_at);

                CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
                    observation_id UNINDEXED, content, tokenize='porter ascii'
                );
                CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
                    INSERT INTO observations_fts(observation_id, content)
                    VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
                    DELETE FROM observations_fts WHERE observation_id=old.id;
                END;
                CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE OF content ON observations BEGIN
                    DELETE FROM observations_fts WHERE observation_id=old.id;
                    INSERT INTO observations_fts(observation_id, content)
                    VALUES (new.id, new.content);
                END;

                CREATE TABLE IF NOT EXISTS propositions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    reasoning TEXT NOT NULL,
                    confidence INTEGER,
                    decay INTEGER,
                    revision_group TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS observation_proposition (
                    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
                    proposition_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
                    PRIMARY KEY (observation_id, proposition_id)
                );

                CREATE TABLE IF NOT EXISTS proposition_updates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    relation TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    reasoning TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS proposition_update_target (
                    update_id INTEGER NOT NULL REFERENCES proposition_updates(id) ON DELETE CASCADE,
                    proposition_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
                    PRIMARY KEY (update_id, proposition_id)
                );
                CREATE TABLE IF NOT EXISTS proposition_update_observation (
                    update_id INTEGER NOT NULL REFERENCES proposition_updates(id) ON DELETE CASCADE,
                    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
                    PRIMARY KEY (update_id, observation_id)
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS proposition_updates_fts USING fts5(
                    update_id UNINDEXED, summary, reasoning, tokenize='porter ascii'
                );
                CREATE TRIGGER IF NOT EXISTS proposition_updates_ai
                AFTER INSERT ON proposition_updates BEGIN
                    INSERT INTO proposition_updates_fts(update_id, summary, reasoning)
                    VALUES (new.id, new.summary, new.reasoning);
                END;
                CREATE TRIGGER IF NOT EXISTS proposition_updates_ad
                AFTER DELETE ON proposition_updates BEGIN
                    DELETE FROM proposition_updates_fts WHERE update_id=old.id;
                END;
                CREATE TRIGGER IF NOT EXISTS proposition_updates_au
                AFTER UPDATE ON proposition_updates BEGIN
                    DELETE FROM proposition_updates_fts WHERE update_id=old.id;
                    INSERT INTO proposition_updates_fts(update_id, summary, reasoning)
                    VALUES (new.id, new.summary, new.reasoning);
                END;

                CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts USING fts5(
                    text, reasoning, content='propositions', content_rowid='id',
                    tokenize='porter ascii'
                );
                CREATE TRIGGER IF NOT EXISTS propositions_ai AFTER INSERT ON propositions BEGIN
                    INSERT INTO propositions_fts(rowid, text, reasoning)
                    VALUES (new.id, new.text, new.reasoning);
                END;
                CREATE TRIGGER IF NOT EXISTS propositions_ad AFTER DELETE ON propositions BEGIN
                    INSERT INTO propositions_fts(propositions_fts, rowid, text, reasoning)
                    VALUES ('delete', old.id, old.text, old.reasoning);
                END;
                CREATE TRIGGER IF NOT EXISTS propositions_au AFTER UPDATE ON propositions BEGIN
                    INSERT INTO propositions_fts(propositions_fts, rowid, text, reasoning)
                    VALUES ('delete', old.id, old.text, old.reasoning);
                    INSERT INTO propositions_fts(rowid, text, reasoning)
                    VALUES (new.id, new.text, new.reasoning);
                END;
                """
            )

    def add_observation(self, observation: ObservationInput) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO observations
                   (id, observer_name, content, content_type, observation_type,
                    session_id, scenario, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    observation.id,
                    observation.observer_name,
                    observation.content,
                    observation.content_type,
                    observation.observation_type,
                    observation.session_id,
                    observation.scenario,
                    observation.created_at,
                ),
            )
            return cursor.rowcount > 0

    def pending_observations(self, limit: int) -> list[ObservationRecord]:
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM observations WHERE processed_at IS NULL
                   ORDER BY created_at ASC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [self._observation(row) for row in rows]

    def mark_processed(self, observation_ids: Iterable[str]) -> None:
        ids = list(observation_ids)
        if not ids:
            return
        with self._connect() as conn:
            conn.executemany(
                "UPDATE observations SET processed_at=? WHERE id=?",
                [(time.time(), observation_id) for observation_id in ids],
            )

    def reset_derived_memory(self) -> None:
        """Delete propositions and make every raw observation pending again."""
        with self._connect() as conn:
            conn.execute("DELETE FROM proposition_updates")
            conn.execute("DELETE FROM propositions")
            conn.execute("UPDATE observations SET processed_at=NULL")
            conn.execute("DELETE FROM sqlite_sequence WHERE name='propositions'")
            conn.execute("DELETE FROM sqlite_sequence WHERE name='proposition_updates'")

    def insert_update(
        self,
        *,
        target_ids: Iterable[int],
        relation: str,
        summary: str,
        reasoning: str,
        observation_ids: Iterable[str],
    ) -> int:
        targets = list(dict.fromkeys(target_ids))
        evidence = list(dict.fromkeys(observation_ids))
        if not targets:
            raise ValueError("a proposition update requires at least one target")
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO proposition_updates
                   (relation, summary, reasoning, created_at) VALUES (?, ?, ?, ?)""",
                (relation, summary, reasoning, time.time()),
            )
            update_id = int(cursor.lastrowid)
            conn.executemany(
                """INSERT INTO proposition_update_target
                   (update_id, proposition_id) VALUES (?, ?)""",
                [(update_id, proposition_id) for proposition_id in targets],
            )
            conn.executemany(
                """INSERT INTO proposition_update_observation
                   (update_id, observation_id) VALUES (?, ?)""",
                [(update_id, observation_id) for observation_id in evidence],
            )
            conn.executemany(
                """INSERT OR IGNORE INTO observation_proposition
                   (observation_id, proposition_id) VALUES (?, ?)""",
                [
                    (observation_id, proposition_id)
                    for proposition_id in targets
                    for observation_id in evidence
                ],
            )
            now = time.time()
            conn.executemany(
                "UPDATE propositions SET updated_at=? WHERE id=?",
                [(now, proposition_id) for proposition_id in targets],
            )
        return update_id

    def insert_proposition(
        self,
        draft: PropositionDraft,
        observation_ids: Iterable[str],
        *,
        revision_group: str | None = None,
        version: int = 1,
    ) -> int:
        now = time.time()
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO propositions
                   (text, reasoning, confidence, decay, revision_group, version,
                    created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    draft.text,
                    draft.reasoning,
                    draft.confidence,
                    draft.decay,
                    revision_group or str(uuid4()),
                    version,
                    now,
                    now,
                ),
            )
            proposition_id = int(cursor.lastrowid)
            conn.executemany(
                """INSERT OR IGNORE INTO observation_proposition
                   (observation_id, proposition_id) VALUES (?, ?)""",
                [(oid, proposition_id) for oid in observation_ids],
            )
        return proposition_id

    def replace_propositions(
        self,
        proposition_ids: Iterable[int],
        revisions: Iterable[tuple[PropositionDraft, Iterable[str]]],
        *,
        revision_group: str | None = None,
    ) -> list[int]:
        """Atomically replace a similar cluster with its revised propositions."""
        old_ids = list(dict.fromkeys(proposition_ids))
        items = [
            (draft, list(dict.fromkeys(evidence))) for draft, evidence in revisions
        ]
        if not old_ids or not items:
            raise ValueError("replacement requires old and revised propositions")
        group = revision_group or str(uuid4())
        now = time.time()
        inserted: list[int] = []
        with self._connect() as conn:
            conn.executemany(
                "DELETE FROM propositions WHERE id=?", [(item,) for item in old_ids]
            )
            for draft, evidence in items:
                cursor = conn.execute(
                    """INSERT INTO propositions
                       (text, reasoning, confidence, decay, revision_group, version,
                        created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
                    (
                        draft.text,
                        draft.reasoning,
                        draft.confidence,
                        draft.decay,
                        group,
                        now,
                        now,
                    ),
                )
                proposition_id = int(cursor.lastrowid)
                inserted.append(proposition_id)
                conn.executemany(
                    """INSERT OR IGNORE INTO observation_proposition
                       (observation_id, proposition_id) VALUES (?, ?)""",
                    [(observation_id, proposition_id) for observation_id in evidence],
                )
        return inserted

    def attach_observations(
        self, proposition_ids: Iterable[int], observation_ids: Iterable[str]
    ) -> None:
        pairs = [(oid, pid) for pid in proposition_ids for oid in observation_ids]
        if not pairs:
            return
        now = time.time()
        with self._connect() as conn:
            conn.executemany(
                """INSERT OR IGNORE INTO observation_proposition
                   (observation_id, proposition_id) VALUES (?, ?)""",
                pairs,
            )
            conn.executemany(
                "UPDATE propositions SET updated_at=? WHERE id=?",
                [(now, pid) for pid in {pair_pid for _, pair_pid in pairs}],
            )

    def delete_propositions(self, proposition_ids: Iterable[int]) -> None:
        ids = list(set(proposition_ids))
        if not ids:
            return
        with self._connect() as conn:
            conn.executemany(
                "DELETE FROM propositions WHERE id=?", [(pid,) for pid in ids]
            )

    def related_observation_ids(self, proposition_ids: Iterable[int]) -> list[str]:
        ids = list(set(proposition_ids))
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT observation_id FROM observation_proposition WHERE proposition_id IN ({marks})",
                ids,
            ).fetchall()
        return [str(row[0]) for row in rows]

    def observations_by_id(
        self, observation_ids: Iterable[str]
    ) -> list[ObservationRecord]:
        ids = list(set(observation_ids))
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM observations WHERE id IN ({marks}) ORDER BY created_at DESC",
                ids,
            ).fetchall()
        return [self._observation(row) for row in rows]

    def propositions_by_id(
        self, proposition_ids: Iterable[int]
    ) -> list[PropositionRecord]:
        ids = list(set(proposition_ids))
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM propositions WHERE id IN ({marks}) ORDER BY id",
                ids,
            ).fetchall()
        return [self._proposition(row) for row in rows]

    def search(
        self,
        query: str = "",
        *,
        limit: int = 3,
        start_time: float | None = None,
        end_time: float | None = None,
        include_observations: int = 1,
    ) -> list[PropositionHit]:
        limit = max(1, min(limit, 50))
        fts = _fts_query(query)
        params: list[object] = []
        if fts:
            sql = """WITH candidates AS (
                         SELECT p.id AS proposition_id,
                                bm25(propositions_fts) * ? AS rank
                         FROM propositions_fts
                         JOIN propositions p ON p.id=propositions_fts.rowid
                         WHERE propositions_fts MATCH ?
                         UNION ALL
                         SELECT op.proposition_id AS proposition_id,
                                bm25(observations_fts) * ? AS rank
                         FROM observations_fts
                         JOIN observation_proposition op
                           ON op.observation_id=observations_fts.observation_id
                         WHERE observations_fts MATCH ?
                         UNION ALL
                         SELECT put.proposition_id AS proposition_id,
                                bm25(proposition_updates_fts) * ? AS rank
                         FROM proposition_updates_fts
                         JOIN proposition_update_target put
                           ON put.update_id=proposition_updates_fts.update_id
                         WHERE proposition_updates_fts MATCH ?
                     ), best AS (
                         SELECT proposition_id, MIN(rank) AS rank
                         FROM candidates GROUP BY proposition_id
                     )
                     SELECT p.*, best.rank AS rank
                     FROM best JOIN propositions p ON p.id=best.proposition_id
                     WHERE 1=1"""
            params.extend(
                (
                    _PROPOSITION_MATCH_WEIGHT,
                    fts,
                    _OBSERVATION_MATCH_WEIGHT,
                    fts,
                    _UPDATE_MATCH_WEIGHT,
                    fts,
                )
            )
        else:
            sql = "SELECT p.*, 0.0 AS rank FROM propositions p WHERE 1=1"
        if start_time is not None:
            sql += " AND p.updated_at >= ?"
            params.append(start_time)
        if end_time is not None:
            sql += " AND p.updated_at <= ?"
            params.append(end_time)
        sql += " ORDER BY " + (
            "rank ASC, p.updated_at DESC" if fts else "p.updated_at DESC"
        )
        sql += " LIMIT ?"
        # Fetch a wider candidate set so proposition-specific durability can
        # influence the final ordering instead of merely decorating BM25 order.
        params.append(min(500, limit * 10))
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
            hits: list[PropositionHit] = []
            for index, row in enumerate(rows):
                observations: list[ObservationRecord] = []
                if include_observations:
                    obs_rows = conn.execute(
                        """SELECT o.* FROM observations o
                           JOIN observation_proposition op ON op.observation_id=o.id
                           WHERE op.proposition_id=? ORDER BY o.created_at DESC LIMIT ?""",
                        (row["id"], include_observations),
                    ).fetchall()
                    observations = [self._observation(item) for item in obs_rows]
                update_rows = conn.execute(
                    """SELECT u.* FROM proposition_updates u
                       JOIN proposition_update_target put ON put.update_id=u.id
                       WHERE put.proposition_id=?
                       ORDER BY u.created_at DESC LIMIT 5""",
                    (row["id"],),
                ).fetchall()
                updates: list[PropositionUpdateRecord] = []
                for update_row in update_rows:
                    evidence_rows = conn.execute(
                        """SELECT observation_id FROM proposition_update_observation
                           WHERE update_id=? ORDER BY observation_id""",
                        (update_row["id"],),
                    ).fetchall()
                    updates.append(
                        self._update(
                            update_row,
                            tuple(str(item[0]) for item in evidence_rows),
                        )
                    )
                lexical = 1.0 / (1.0 + index)
                age_days = max(0.0, (time.time() - float(row["updated_at"])) / 86400)
                durability = max(1, min(10, int(row["decay"] or 5)))
                half_life_days = 1.0 + (durability - 1) * 40.0
                score = lexical * math.exp(-math.log(2) * age_days / half_life_days)
                hits.append(
                    PropositionHit(self._proposition(row), score, observations, updates)
                )
        return sorted(hits, key=lambda hit: hit.score, reverse=True)[:limit]

    @staticmethod
    def _observation(row: sqlite3.Row) -> ObservationRecord:
        return ObservationRecord(
            id=row["id"],
            content=row["content"],
            created_at=row["created_at"],
            observation_type=row["observation_type"],
            session_id=row["session_id"],
            scenario=row["scenario"],
            observer_name=row["observer_name"],
            content_type=row["content_type"],
            processed_at=row["processed_at"],
        )

    @staticmethod
    def _proposition(row: sqlite3.Row) -> PropositionRecord:
        return PropositionRecord(
            id=row["id"],
            text=row["text"],
            reasoning=row["reasoning"],
            confidence=row["confidence"],
            decay=row["decay"],
            revision_group=row["revision_group"],
            version=row["version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _update(
        row: sqlite3.Row, observation_ids: tuple[str, ...]
    ) -> PropositionUpdateRecord:
        return PropositionUpdateRecord(
            id=row["id"],
            relation=row["relation"],
            summary=row["summary"],
            reasoning=row["reasoning"],
            created_at=row["created_at"],
            observation_ids=observation_ids,
        )
