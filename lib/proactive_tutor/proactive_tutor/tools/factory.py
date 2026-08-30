from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from proactive_tutor.tools.apple_calendar import AppleCalendarProvider
from proactive_tutor.tools.base import CompositeToolProvider, ToolProvider
from proactive_tutor.tools.mcp import MCPServerConfig, MCPToolProvider
from proactive_tutor.tools.native import NativeToolProvider

_GOOGLE_CALENDAR_READ_TOOLS = (
    "list-calendars",
    "list-events",
    "search-events",
    "get-event",
    "get-freebusy",
    "get-current-time",
    "list-colors",
)


def _env_enabled(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().casefold() not in {"", "0", "false", "no", "off"}


def _json_string_list(name: str, default: list[str]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if not raw:
        return tuple(default)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{name} must contain a JSON string array") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{name} must contain a JSON string array")
    return tuple(value)


def _google_calendar_provider() -> MCPToolProvider:
    command = os.environ.get(
        "COCO_GOOGLE_CALENDAR_MCP_COMMAND",
        "google-calendar-mcp",
    ).strip()
    args = _json_string_list(
        "COCO_GOOGLE_CALENDAR_MCP_ARGS",
        [],
    )
    return MCPToolProvider(
        MCPServerConfig(
            name="google_calendar",
            command=command,
            args=args,
            # Use nspady/google-calendar-mcp's own filtering as the first
            # boundary, then repeat the allowlist in MCPToolProvider. This
            # keeps mutations unavailable even if either side changes.
            env={"ENABLED_TOOLS": ",".join(_GOOGLE_CALENDAR_READ_TOOLS)},
            forward_env=(
                "GOOGLE_OAUTH_CREDENTIALS",
                "GOOGLE_CALENDAR_MCP_TOKEN_PATH",
            ),
            include_tools=_GOOGLE_CALENDAR_READ_TOOLS,
            read_only_tools=_GOOGLE_CALENDAR_READ_TOOLS,
            name_prefix="google_calendar_",
            instructions="""
- Google Calendar data is private. Use google_calendar_* only when the user asks about their Google schedule, events, calendars, or availability, and request the smallest useful time range.
- Prefer these tools when the user explicitly names Google Calendar or a Google account. Do not query both Google and Apple Calendar by default because the same Google events may already be synced into Apple Calendar.
- Use ISO 8601/RFC 3339 boundaries with the local UTC offset from current_datetime. Never invent an event or availability absent from the tool result.
- The Google Calendar tools in this build are read-only. Do not claim that an event was created, updated, deleted, or accepted.
""",
        )
    )


def build_tutor_tool_provider(
    *,
    enable_memory: bool,
    enable_screen: bool,
    enable_calendars: bool,
    screen_observer: Callable[[str], dict[str, Any]],
    get_user_context: Callable[..., Awaitable[dict[str, Any]]],
    get_recent_observations: Callable[..., Awaitable[dict[str, Any]]],
) -> ToolProvider:
    """Build the effective tool surface for one TutorAgent instance."""
    providers: list[ToolProvider] = [
        NativeToolProvider(
            enable_memory=enable_memory,
            enable_screen=enable_screen,
            screen_observer=screen_observer,
            get_user_context=get_user_context,
            get_recent_observations=get_recent_observations,
        )
    ]
    if enable_calendars and _env_enabled("COCO_APPLE_CALENDAR_ENABLED", True):
        providers.append(AppleCalendarProvider())
    if enable_calendars and _env_enabled("COCO_GOOGLE_CALENDAR_ENABLED", True):
        providers.append(_google_calendar_provider())
    return CompositeToolProvider(providers)
