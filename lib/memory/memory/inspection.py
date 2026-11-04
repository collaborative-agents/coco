"""Read-only, bounded inspection of observer-curated context for the desktop."""

import sqlite3
from pathlib import Path

from memory.context_groups import context_branch


def inspect_context(
    db_path: str | Path,
    query: str = "",
    offset: int = 0,
    limit: int = 20,
    group_by: str = "topic",
    group: str = "",
    trail: list[str] | None = None,
) -> dict:
    if not 0 <= offset or not 1 <= limit <= 50 or len(query) > 200:
        raise ValueError("Invalid context query")
    if group_by not in {"topic", "date", "app"} or len(group) > 100:
        raise ValueError("Invalid context grouping")
    trail = trail if trail is not None else ([group] if group else [])
    if (
        not isinstance(trail, list)
        or len(trail) > 32
        or any(not isinstance(key, str) or len(key) > 160 for key in trail)
    ):
        raise ValueError("Invalid context path")
    path = Path(db_path).expanduser().resolve()
    empty = {
        "items": [],
        "total": 0,
        "offset": offset,
        "limit": limit,
        "groups": [],
        "matchedTotal": 0,
        "groupBy": group_by,
        "breadcrumbs": [],
        "leaf": True,
        "grouping": group_by,
    }
    if not path.exists():
        return empty
    # Inspection never creates, initializes, or migrates the user's database.
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2) as conn:
        conn.row_factory = sqlite3.Row
        pattern = (
            "%"
            + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            + "%"
        )
        where = "WHERE text LIKE ? ESCAPE '\\'"
        # Group every matching insight, not just the visible page. Evidence is
        # loaded only for the selected page, so thousands of insights stay cheap.
        candidates = conn.execute(
            f"SELECT id, text, reasoning, updated_at FROM propositions {where} ORDER BY updated_at DESC, id DESC",
            (pattern,),
        ).fetchall()
        selected, groups, breadcrumbs, leaf, grouping = context_branch(
            candidates, group_by, trail
        )
        total = len(selected)
        rows = selected if leaf else []
        items = []
        for row in rows:
            evidence = conn.execute(
                """SELECT o.id, o.content, o.created_at FROM observations o
                JOIN observation_proposition op ON op.observation_id=o.id
                WHERE op.proposition_id=? ORDER BY o.created_at DESC, o.id LIMIT 5""",
                (row["id"],),
            ).fetchall()
            count = conn.execute(
                "SELECT COUNT(*) FROM observation_proposition WHERE proposition_id=?",
                (row["id"],),
            ).fetchone()[0]
            items.append(
                {
                    "id": row["id"],
                    "text": row["text"],
                    "reasoning": row["reasoning"],
                    "updatedAt": row["updated_at"],
                    "evidenceCount": count,
                    "evidence": [
                        {
                            "id": e["id"],
                            "content": e["content"],
                            "createdAt": e["created_at"],
                        }
                        for e in evidence
                    ],
                }
            )
        return {
            **empty,
            "items": items,
            "total": total,
            "groups": groups,
            "matchedTotal": len(candidates),
            "breadcrumbs": breadcrumbs,
            "leaf": leaf,
            "grouping": grouping,
        }


def change_insight(
    db_path: str | Path, insight_id: int, expected: str, text: str | None
) -> None:
    """Edit in place, preserving evidence; deletion removes links, not observations."""
    import time

    if text is not None and (not text.strip() or len(text) > 100_000):
        raise ValueError("Insight must contain between 1 and 100,000 characters.")
    path = Path(db_path).expanduser().resolve()
    with sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=5) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT text FROM propositions WHERE id=?", (insight_id,)
        ).fetchone()
        if row is None or row[0] != expected:
            raise ValueError(
                "This insight changed or was removed. Reopen the group to try again."
            )
        if text is None:
            conn.execute("DELETE FROM propositions WHERE id=?", (insight_id,))
        else:
            conn.execute(
                "UPDATE propositions SET text=?, updated_at=?, version=version+1 WHERE id=?",
                (text.strip(), time.time(), insight_id),
            )
