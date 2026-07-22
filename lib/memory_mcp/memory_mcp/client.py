from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Call Coco's get_user_context MCP tool over local stdio."
    )
    parser.add_argument("query", nargs="?", default="")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--evidence-limit", type=int, default=1)
    parser.add_argument("--start-hh-mm-ago")
    parser.add_argument("--end-hh-mm-ago")
    parser.add_argument(
        "--db",
        type=Path,
        help="Override COCO_MEMORY_DB_PATH for this query.",
    )
    return parser


async def call_get_user_context(
    *,
    query: str,
    limit: int = 3,
    evidence_limit: int = 1,
    start_hh_mm_ago: str | None = None,
    end_hh_mm_ago: str | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    """Launch the local server and invoke its retrieval tool over MCP stdio."""
    child_env = dict(os.environ)
    if db_path is not None:
        child_env["COCO_MEMORY_DB_PATH"] = str(db_path.expanduser().resolve())
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "memory_mcp.server"],
        env=child_env,
    )
    arguments = {
        "query": query,
        "limit": limit,
        "evidence_limit": evidence_limit,
        "start_hh_mm_ago": start_hh_mm_ago,
        "end_hh_mm_ago": end_hh_mm_ago,
    }
    async with stdio_client(server) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            result = await session.call_tool("get_user_context", arguments)
    if result.isError:
        message = "\n".join(str(getattr(item, "text", item)) for item in result.content)
        raise RuntimeError(message or "get_user_context failed")
    if result.structuredContent is None:
        raise RuntimeError("get_user_context returned no structured content")
    return result.structuredContent


def main() -> None:
    args = _parser().parse_args()
    try:
        response = asyncio.run(
            call_get_user_context(
                query=args.query,
                limit=args.limit,
                evidence_limit=args.evidence_limit,
                start_hh_mm_ago=args.start_hh_mm_ago,
                end_hh_mm_ago=args.end_hh_mm_ago,
                db_path=args.db,
            )
        )
    except (RuntimeError, ValueError) as exc:
        raise SystemExit(f"Memory MCP query failed: {exc}") from exc
    print(json.dumps(response, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
