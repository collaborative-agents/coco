from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest
from memory import MemoryFileSystem, MemoryStore, ObservationInput, pipe
from memory.models import PropositionDraft


def _memory(tmp_path) -> tuple[MemoryFileSystem, object, object]:
    store = MemoryStore(tmp_path / "memory.db")
    observations = [
        ObservationInput("old", "OAuth callback first failed", 10.0),
        ObservationInput("new", "OAuth callback fixed in VS Code", 30.0),
        ObservationInput("other", "Reviewing a roadmap", 20.0),
    ]
    for observation in observations:
        store.add_observation(observation)
    oauth_id = store.insert_proposition(
        PropositionDraft("User debugs an OAuth callback", "Observed twice", 9, 8),
        ["old", "new"],
    )
    roadmap_id = store.insert_proposition(
        PropositionDraft("User reviews a product roadmap", "Observed once", 5, 4),
        ["other"],
    )
    oauth, roadmap = store.propositions_by_id([oauth_id, roadmap_id])
    return MemoryFileSystem(store), oauth, roadmap


def test_read_commands_and_metadata(tmp_path) -> None:
    memory, oauth, _ = _memory(tmp_path)

    assert memory.cat(oauth) == "User debugs an OAuth callback"
    assert [item.id for item in memory.head(oauth, 1)] == ["new"]
    assert [item.id for item in memory.tail(oauth, 1)] == ["old"]
    assert [item.id for item in memory.read(oauth)[1]] == ["new", "old"]
    assert memory.du(oauth) == 2
    assert memory.stat(oauth)["durability"] == 8
    assert memory.stat(oauth)["observation_count"] == 2
    assert (
        memory.stat(oauth)["proposition_time"]["created_at"]["unix"] == oauth.created_at
    )
    assert memory.stat(oauth)["observation_time"] == {
        "oldest_at": {"unix": 10.0, "iso": "1970-01-01T00:00:10Z"},
        "newest_at": {"unix": 30.0, "iso": "1970-01-01T00:00:30Z"},
    }
    assert memory.df() | {"database_bytes": 0} == {
        "propositions": 2,
        "observations": 3,
        "links": 3,
        "pending_observations": 3,
        "unlinked_observations": 0,
        "database_bytes": 0,
    }


def test_ls_grep_bm25_and_find(tmp_path) -> None:
    memory, oauth, roadmap = _memory(tmp_path)

    assert memory.ls("confidence") == [oauth, roadmap]
    assert memory.grep("OAUTH", memory.ls()) == [oauth]
    assert memory.grep(re.compile(r"product\s+road"), memory.ls()) == [roadmap]
    assert memory.bm25("oauth callback", [roadmap, oauth]) == [oauth]
    assert memory.find(memory.ls(), min_confidence=8, min_durability=7) == [oauth]


def test_pipe_is_eager_and_passes_each_result_to_the_next_stage(tmp_path) -> None:
    memory, oauth, _ = _memory(tmp_path)
    calls: list[str] = []

    result = pipe(
        memory.ls("time"),
        lambda items: calls.append("grep") or memory.grep("OAuth", items),
        lambda items: calls.append("bm25") or memory.bm25("callback", items),
    )

    assert result == [oauth]
    assert calls == ["grep", "bm25"]


def test_invalid_arguments_fail_early(tmp_path) -> None:
    memory, oauth, _ = _memory(tmp_path)

    with pytest.raises(ValueError, match="sort_by"):
        memory.ls("size")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="non-negative"):
        memory.head(oauth, -1)
    with pytest.raises(ValueError, match="time_start"):
        memory.find([oauth], time_start=2, time_end=1)


def test_find_accepts_iso_dates_and_selects_timestamp_semantics(tmp_path) -> None:
    store = MemoryStore(tmp_path / "calendar-memory.db")
    happened_at = datetime(2026, 7, 30, 23, 45, tzinfo=UTC).timestamp()
    store.add_observation(
        ObservationInput("promise", "Promised to send the draft", happened_at)
    )
    proposition_id = store.insert_proposition(
        PropositionDraft("User promised to send the draft", "Observed", 9, 8),
        ["promise"],
    )
    proposition = store.propositions_by_id([proposition_id])[0]
    memory = MemoryFileSystem(store)

    assert memory.find(
        [proposition], time_start="2026-07-27", time_end="2026-07-30"
    ) == [proposition]
    assert memory.find(
        [proposition],
        time_start="2026-07-30T16:45:00-07:00",
        time_end="2026-07-30T16:45:00-07:00",
    ) == [proposition]
    assert (
        memory.find(
            [proposition],
            time_start="2026-07-27",
            time_end="2026-08-02",
            time_field="proposition_updated",
        )
        == []
    )

    _, inclusive_end = memory.normalize_time_range(None, "2026-08-02")
    assert datetime.fromtimestamp(inclusive_end or 0, UTC).date().isoformat() == (
        "2026-08-02"
    )

    with pytest.raises(ValueError, match="ISO-8601"):
        memory.find([proposition], time_start="July sometime")
    with pytest.raises(ValueError, match="time_field"):
        memory.find([proposition], time_field="filesystem")  # type: ignore[arg-type]
