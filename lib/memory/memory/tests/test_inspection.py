import sqlite3

import pytest
from memory import MemoryStore, ObservationInput
from memory.inspection import inspect_context
from memory.models import PropositionDraft


def test_missing_store_is_empty_without_creating_database(tmp_path):
    db = tmp_path / "missing.db"
    assert inspect_context(db)["total"] == 0
    assert not db.exists()


def test_context_search_and_leaf_evidence_are_read_only(tmp_path):
    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    for i in range(7):
        store.add_observation(
            ObservationInput(id=str(i), content=f"Observation {i}", created_at=i + 1)
        )
    store.insert_proposition(
        PropositionDraft("Uses 100% zoom", "Repeated screen observations"),
        [str(i) for i in range(7)],
    )
    store.insert_proposition(
        PropositionDraft("Works on reports", "Observed editing reports"), []
    )
    with sqlite3.connect(db) as conn:
        before = list(conn.iterdump())
    result = inspect_context(db, query="%")
    assert result["total"] == 1  # Literal search, not a wildcard.
    item = result["items"][0]
    assert item["text"] == "Uses 100% zoom"
    assert item["evidenceCount"] == 7
    assert len(item["evidence"]) == 5
    assert item["evidence"][0]["content"] == "Observation 6"
    assert inspect_context(db)["total"] == 2
    assert len(inspect_context(db)["items"]) == 2
    assert inspect_context(db, query="' OR 1=1 --")["items"] == []
    with sqlite3.connect(db) as conn:
        assert list(conn.iterdump()) == before


@pytest.mark.parametrize(
    "kwargs", [{"limit": 100}, {"offset": -1}, {"query": "a" * 201}]
)
def test_rejects_unbounded_queries(tmp_path, kwargs):
    with pytest.raises(ValueError):
        inspect_context(tmp_path / "memory.db", **kwargs)


def test_groups_cover_full_result_set_and_filter_before_pagination(tmp_path):
    db = tmp_path / "memory.db"
    MemoryStore(db)
    # Match the size of a real user library; grouping must not stop at page 1.
    with sqlite3.connect(db) as conn:
        conn.executemany(
            "INSERT INTO propositions (text, reasoning, revision_group, version, created_at, updated_at) VALUES (?, '', '', 1, ?, ?)",
            [
                (
                    "Debugging code in VS Code and iTerm2"
                    if i < 2000
                    else "Editing a document in Overleaf",
                    1735689600,
                    1735689600 if i < 2000 else 1738368000,
                )
                for i in range(3494)
            ],
        )
    result = inspect_context(db)
    assert result["matchedTotal"] == 3494
    assert sum(g["count"] for g in result["groups"]) == 3494
    assert result["items"] == []
    assert not result["leaf"]
    apps = inspect_context(db, group_by="app")
    assert next(g["count"] for g in apps["groups"] if g["id"] == "iTerm") == 2000
    trail = ["VS Code"]
    branch = inspect_context(db, group_by="app", trail=trail)
    assert branch["total"] == 2000
    assert branch["breadcrumbs"][0]["label"] == "VS Code"
    for _ in range(10):
        if branch["leaf"]:
            break
        assert branch["items"] == []
        previous_count = branch["total"]
        trail.append(branch["groups"][0]["id"])
        branch = inspect_context(db, group_by="app", trail=trail)
        assert branch["total"] < previous_count
    assert branch["leaf"]
    assert 1 <= len(branch["items"]) <= 8
    assert all("VS Code" in item["text"] for item in branch["items"])
    assert len(branch["breadcrumbs"]) == len(trail)
    # Backtracking reconstructs the same focused parent.
    parent = inspect_context(db, group_by="app", trail=trail[:-1])
    assert any(g["id"] == trail[-1] for g in parent["groups"])
    months = inspect_context(db, group_by="date", trail=["2025-02"])
    assert months["total"] == 1494
    assert months["breadcrumbs"][0]["label"] == "February 2025"
    search = inspect_context(db, query="Overleaf", group_by="app")
    assert search["matchedTotal"] == 1494
    assert search["groups"] == [{"id": "Overleaf", "label": "Overleaf", "count": 1494}]


def test_unknown_apps_are_not_fabricated(tmp_path):
    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    for _ in range(9):
        store.insert_proposition(
            PropositionDraft("Prefers morning work", "Repeated pattern"), []
        )
    result = inspect_context(db, group_by="app")
    assert result["groups"] == [
        {"id": "No app identified", "label": "No app identified", "count": 9}
    ]


@pytest.mark.parametrize("trail", ["bad", [1], ["x"] * 33, ["x" * 161]])
def test_rejects_malformed_hierarchy_paths(tmp_path, trail):
    with pytest.raises(ValueError):
        inspect_context(tmp_path / "memory.db", trail=trail)


def test_rejects_stale_group_path(tmp_path):
    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    for _ in range(9):
        store.insert_proposition(PropositionDraft("Editing a document", ""), [])
    with pytest.raises(ValueError, match="group has changed"):
        inspect_context(db, trail=["Missing group"])


def test_every_insight_is_reachable_when_all_topics_apps_and_dates_are_identical(
    tmp_path,
):
    db = tmp_path / "memory.db"
    MemoryStore(db)
    with sqlite3.connect(db) as conn:
        conn.executemany(
            "INSERT INTO propositions (text, reasoning, revision_group, version, created_at, updated_at) VALUES ('Debugging code in VS Code', '', '', 1, 100, 100)",
            [() for _ in range(80)],
        )
    pending, found = [[]], set()
    while pending:
        trail = pending.pop()
        branch = inspect_context(db, trail=trail)
        if branch["leaf"]:
            assert len(branch["items"]) <= 8
            found.update(item["id"] for item in branch["items"])
        else:
            assert branch["items"] == []
            pending.extend([*trail, group["id"]] for group in branch["groups"])
    assert len(found) == 80


def test_edit_delete_preserve_evidence_and_reject_stale_changes(tmp_path):
    from memory.inspection import change_insight

    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    store.add_observation(
        ObservationInput(id="evidence", content="Original observation", created_at=1)
    )
    store.insert_proposition(
        PropositionDraft("Original insight", "Observed"), ["evidence"]
    )
    store.insert_proposition(PropositionDraft("Unrelated insight", "Observed"), [])
    item = next(
        i for i in inspect_context(db)["items"] if i["text"] == "Original insight"
    )
    change_insight(db, item["id"], item["text"], "Edited insight")
    edited = next(i for i in inspect_context(db)["items"] if i["id"] == item["id"])
    assert edited["text"] == "Edited insight"
    assert edited["evidence"] == item["evidence"]
    with pytest.raises(ValueError):
        change_insight(db, item["id"], item["text"], None)
    with pytest.raises(ValueError):
        change_insight(db, item["id"], "Edited insight", "  ")
    with sqlite3.connect(db) as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM propositions_fts WHERE propositions_fts MATCH 'Edited'"
            ).fetchone()[0]
            == 1
        )
    change_insight(db, item["id"], "Edited insight", None)
    assert [i["text"] for i in inspect_context(db)["items"]] == ["Unrelated insight"]
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT count(*) FROM observations").fetchone()[0] == 1
        assert (
            conn.execute("SELECT count(*) FROM observation_proposition").fetchone()[0]
            == 0
        )
        assert (
            conn.execute(
                "SELECT count(*) FROM propositions_fts WHERE propositions_fts MATCH 'Edited'"
            ).fetchone()[0]
            == 0
        )
