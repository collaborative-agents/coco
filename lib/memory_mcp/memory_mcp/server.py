from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from memory.paths import default_memory_db_path
from memory.store import MemoryStore


def _timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, tz=UTC).isoformat(timespec="seconds")


def _ago_timestamp(value: str | None, *, now: float) -> float | None:
    if value is None:
        return None
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError("time offsets must use HH:MM, for example 01:30")
    try:
        hours, minutes = (int(part) for part in parts)
    except ValueError as exc:
        raise ValueError("time offsets must contain integer hours and minutes") from exc
    if hours < 0 or not 0 <= minutes < 60:
        raise ValueError("time offsets require non-negative hours and minutes 00-59")
    return now - hours * 3600 - minutes * 60


def query_user_context(
    store: MemoryStore,
    *,
    query: str = "",
    start_hh_mm_ago: str | None = None,
    end_hh_mm_ago: str | None = None,
    limit: int = 3,
    evidence_limit: int = 1,
    now: float | None = None,
) -> dict[str, Any]:
    """Run and serialize one memory query independently of MCP transport."""
    if not 1 <= limit <= 20:
        raise ValueError("limit must be between 1 and 20")
    if not 0 <= evidence_limit <= 5:
        raise ValueError("evidence_limit must be between 0 and 5")
    current_time = time.time() if now is None else now
    start_time = _ago_timestamp(start_hh_mm_ago, now=current_time)
    end_time = _ago_timestamp(end_hh_mm_ago, now=current_time)
    if start_time is not None and end_time is not None and start_time > end_time:
        raise ValueError(
            "start_hh_mm_ago must describe an older time than end_hh_mm_ago"
        )

    hits = store.search(
        query,
        limit=limit,
        start_time=start_time,
        end_time=end_time,
        include_observations=evidence_limit,
    )
    results: list[dict[str, Any]] = []
    for hit in hits:
        proposition = hit.proposition
        results.append(
            {
                "id": proposition.id,
                "text": proposition.text,
                "reasoning": proposition.reasoning,
                "confidence": proposition.confidence,
                "durability": proposition.decay,
                "score": hit.score,
                "created_at": _timestamp(proposition.created_at),
                "updated_at": _timestamp(proposition.updated_at),
                "updates": [
                    {
                        "id": update.id,
                        "relation": update.relation,
                        "summary": update.summary,
                        "reasoning": update.reasoning,
                        "created_at": _timestamp(update.created_at),
                        "observation_ids": list(update.observation_ids),
                    }
                    for update in hit.updates
                ],
                "evidence": [
                    {
                        "id": observation.id,
                        "observer_name": observation.observer_name,
                        "content": observation.content,
                        "created_at": _timestamp(observation.created_at),
                        "observation_type": observation.observation_type,
                        "session_id": observation.session_id,
                        "scenario": observation.scenario,
                    }
                    for observation in hit.observations
                ],
            }
        )
    return {
        "query": query,
        "start_hh_mm_ago": start_hh_mm_ago,
        "end_hh_mm_ago": end_hh_mm_ago,
        "count": len(results),
        "results": results,
    }


def query_recent_observations(
    store: MemoryStore,
    *,
    limit: int = 10,
    start_hh_mm_ago: str | None = None,
    end_hh_mm_ago: str | None = None,
    session_id: str | None = None,
    observation_type: str | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Run and serialize one recent-observation query without MCP transport."""
    if not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    current_time = time.time() if now is None else now
    start_time = _ago_timestamp(start_hh_mm_ago, now=current_time)
    end_time = _ago_timestamp(end_hh_mm_ago, now=current_time)
    if start_time is not None and end_time is not None and start_time > end_time:
        raise ValueError(
            "start_hh_mm_ago must describe an older time than end_hh_mm_ago"
        )

    observations = store.recent_observations(
        limit,
        start_time=start_time,
        end_time=end_time,
        session_id=session_id,
        observation_type=observation_type,
    )
    return {
        "start_hh_mm_ago": start_hh_mm_ago,
        "end_hh_mm_ago": end_hh_mm_ago,
        "session_id": session_id,
        "observation_type": observation_type,
        "count": len(observations),
        "observations": [
            {
                "id": observation.id,
                "observer_name": observation.observer_name,
                "content": observation.content,
                "content_type": observation.content_type,
                "observation_type": observation.observation_type,
                "session_id": observation.session_id,
                "scenario": observation.scenario,
                "created_at": _timestamp(observation.created_at),
            }
            for observation in observations
        ],
    }


class AppContext:
    def __init__(self, store: MemoryStore):
        self.store = store


@asynccontextmanager
async def app_lifespan(_server: FastMCP) -> AsyncIterator[AppContext]:
    load_dotenv()
    yield AppContext(store=MemoryStore(default_memory_db_path()))


mcp = FastMCP("coco-memory", lifespan=app_lifespan)


@mcp.tool()
async def get_user_context(
    query: str = "",
    start_hh_mm_ago: str | None = None,
    end_hh_mm_ago: str | None = None,
    limit: int = 3,
    evidence_limit: int = 1,
) -> dict[str, Any]:
    """Retrieve relevant historical context from Coco's local memory.

    Use a concise, specific lexical query. An empty query returns recent
    propositions. Time offsets use HH:MM relative to now: start is the older
    boundary and end is the newer boundary. Evidence may contain sensitive raw
    observer output; request only what is needed.
    """
    context = mcp.get_context()
    app_context = context.request_context.lifespan_context
    return await asyncio.to_thread(
        query_user_context,
        app_context.store,
        query=query,
        start_hh_mm_ago=start_hh_mm_ago,
        end_hh_mm_ago=end_hh_mm_ago,
        limit=limit,
        evidence_limit=evidence_limit,
    )


@mcp.tool()
async def get_recent_observations(
    limit: int = 10,
    start_hh_mm_ago: str | None = None,
    end_hh_mm_ago: str | None = None,
    session_id: str | None = None,
    observation_type: str | None = None,
) -> dict[str, Any]:
    """Retrieve Coco's newest raw observations in reverse chronological order.

    Time offsets use HH:MM relative to now: start is the older boundary and end
    is the newer boundary. Optional session and type filters require exact
    matches. Raw observer output may be sensitive; request only what is needed.
    """
    context = mcp.get_context()
    app_context = context.request_context.lifespan_context
    return await asyncio.to_thread(
        query_recent_observations,
        app_context.store,
        limit=limit,
        start_hh_mm_ago=start_hh_mm_ago,
        end_hh_mm_ago=end_hh_mm_ago,
        session_id=session_id,
        observation_type=observation_type,
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
