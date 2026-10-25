"""Composable tool providers for the tutor agent."""

from proactive_tutor.tools.apple_calendar import AppleCalendarProvider
from proactive_tutor.tools.base import (
    CompositeToolProvider,
    ToolDefinition,
    ToolProvider,
)
from proactive_tutor.tools.factory import build_tutor_tool_provider
from proactive_tutor.tools.mcp import MCPServerConfig, MCPToolProvider
from proactive_tutor.tools.native import NativeToolProvider

__all__ = [
    "AppleCalendarProvider",
    "CompositeToolProvider",
    "MCPServerConfig",
    "MCPToolProvider",
    "NativeToolProvider",
    "ToolDefinition",
    "ToolProvider",
    "build_tutor_tool_provider",
]
