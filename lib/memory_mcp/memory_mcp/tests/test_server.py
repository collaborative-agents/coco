"""Tests for the memory_mcp.server module.

```
uv run pytest lib/memory_mcp/memory_mcp/tests/test_server.py
```
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

from memory.models import ObservationInput, PropositionDraft
from memory.store import MemoryStore
from memory_mcp.client import call_get_user_context
from memory_mcp.server import _ago_timestamp, query_user_context


def test_ago_timestamp_parses_relative_window() -> None:
    assert _ago_timestamp("01:30", now=10_000) == 4_600


def test_ago_timestamp_rejects_invalid_minutes() -> None:
    try:
        _ago_timestamp("01:60", now=10_000)
    except ValueError as exc:
        assert "00-59" in str(exc)
    else:
        raise AssertionError("invalid offset was accepted")


def test_query_returns_structured_proposition_updates_and_evidence(tmp_path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(
        ObservationInput(
            id="oauth-observation",
            content="Debugging a Keycloak OAuth callback in Cursor",
            created_at=1_000,
            observation_type="snapshot",
            session_id="session-1",
        )
    )
    proposition_id = store.insert_proposition(
        PropositionDraft(
            text="The user is debugging OAuth authentication",
            reasoning="A Keycloak callback failed",
            confidence=8,
            decay=4,
        ),
        ["oauth-observation"],
    )
    store.insert_update(
        target_ids=[proposition_id],
        relation="IDENTICAL",
        summary="The Keycloak callback failed again.",
        reasoning="New evidence corroborates the existing task.",
        observation_ids=["oauth-observation"],
    )

    response = query_user_context(
        store,
        query="Keycloak OAuth",
        evidence_limit=1,
    )

    assert response["count"] == 1
    result = response["results"][0]
    assert result["id"] == proposition_id
    assert result["updates"][0]["relation"] == "IDENTICAL"
    assert result["evidence"][0]["id"] == "oauth-observation"


def test_query_validates_limits(tmp_path) -> None:
    store = MemoryStore(tmp_path / "memory.db")

    try:
        query_user_context(store, limit=0)
    except ValueError as exc:
        assert "limit" in str(exc)
    else:
        raise AssertionError("invalid result limit was accepted")


def test_server_supports_mcp_cli_file_import() -> None:
    """MCP CLI executes the file without first adding it to sys.modules."""
    server_path = Path(__file__).parents[1] / "server.py"
    spec = importlib.util.spec_from_file_location("mcp_cli_server", server_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)

    spec.loader.exec_module(module)

    assert module.mcp.name == "coco-memory"


def test_cli_client_calls_get_user_context_over_stdio(tmp_path) -> None:
    db_path = tmp_path / "memory.db"
    store = MemoryStore(db_path)
    store.add_observation(
        ObservationInput(
            id="figma-observation",
            content="Editing the collaboration diagram in Figma",
            created_at=1_000,
        )
    )
    store.insert_proposition(
        PropositionDraft(
            text="The user is editing a collaboration diagram in Figma",
            reasoning="The canvas and layers were visible",
            confidence=8,
            decay=4,
        ),
        ["figma-observation"],
    )

    response = asyncio.run(
        call_get_user_context(
            query="Figma collaboration",
            evidence_limit=0,
            db_path=db_path,
        )
    )

    assert response["count"] == 1
    assert response["results"][0]["text"].endswith("in Figma")
