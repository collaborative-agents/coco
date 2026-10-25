from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from proactive_tutor.tools.base import ToolDefinition, ToolProvider

logger = logging.getLogger(__name__)

_SAFE_STDIO_ENV = (
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SHELL",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
)


@dataclass(frozen=True)
class MCPServerConfig:
    """Configuration for one local stdio MCP tool server."""

    name: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    forward_env: tuple[str, ...] = ()
    include_tools: tuple[str, ...] = ()
    exclude_tools: tuple[str, ...] = ()
    read_only_tools: tuple[str, ...] = ()
    name_prefix: str = ""
    instructions: str = ""
    timeout_seconds: float = 30.0
    max_result_chars: int = 32_000
    read_only_only: bool = True


def _matches(name: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def _safe_tool_name(prefix: str, name: str) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_-]", "_", f"{prefix}{name}")
    candidate = re.sub(r"_+", "_", candidate).strip("_") or "mcp_tool"
    if len(candidate) <= 64:
        return candidate
    digest = hashlib.sha256(candidate.encode()).hexdigest()[:10]
    return f"{candidate[:53]}_{digest}"


class MCPToolProvider(ToolProvider):
    """Discover and invoke tools supplied by a local MCP stdio server."""

    _FAILED_DISCOVERY_RETRY_SECONDS = 30.0

    def __init__(self, config: MCPServerConfig):
        self.config = config
        self._definitions: list[ToolDefinition] | None = None
        self._original_names: dict[str, str] = {}
        self._discovery_lock = threading.Lock()
        self._retry_after = 0.0

    def _command_available(self) -> bool:
        command = self.config.command
        if os.path.sep in command:
            return Path(command).expanduser().is_file()
        return shutil.which(command) is not None

    def _server_parameters(self) -> StdioServerParameters:
        allowed = {
            name.casefold() for name in (*_SAFE_STDIO_ENV, *self.config.forward_env)
        }
        child_env = {
            name: value
            for name, value in os.environ.items()
            if name.casefold() in allowed
        }
        child_env.update(self.config.env)
        return StdioServerParameters(
            command=str(Path(self.config.command).expanduser())
            if os.path.sep in self.config.command
            else self.config.command,
            args=list(self.config.args),
            env=child_env,
        )

    async def _list_tools(self):
        timeout = timedelta(seconds=self.config.timeout_seconds)
        async with stdio_client(self._server_parameters()) as streams:
            async with ClientSession(
                *streams,
                read_timeout_seconds=timeout,
            ) as session:
                await session.initialize()
                return (await session.list_tools()).tools

    @staticmethod
    def _annotation_read_only(tool: Any) -> bool:
        annotations = getattr(tool, "annotations", None)
        return bool(
            annotations is not None
            and getattr(annotations, "readOnlyHint", False) is True
        )

    def _tool_is_included(self, name: str) -> bool:
        if self.config.include_tools and not _matches(name, self.config.include_tools):
            return False
        return not _matches(name, self.config.exclude_tools)

    def _discover(self) -> list[ToolDefinition]:
        if not self._command_available():
            return []
        tools = asyncio.run(self._list_tools())
        definitions: list[ToolDefinition] = []
        original_names: dict[str, str] = {}
        for tool in tools:
            original_name = str(tool.name)
            if not self._tool_is_included(original_name):
                continue
            read_only = self._annotation_read_only(tool) or _matches(
                original_name,
                self.config.read_only_tools,
            )
            if self.config.read_only_only and not read_only:
                continue
            exposed_name = _safe_tool_name(
                self.config.name_prefix,
                original_name,
            )
            if exposed_name in original_names:
                raise ValueError(
                    f"MCP tools normalize to the same name: {exposed_name}"
                )
            parameters = deepcopy(getattr(tool, "inputSchema", None) or {})
            if not isinstance(parameters, dict):
                parameters = {"type": "object", "properties": {}}
            parameters.setdefault("type", "object")
            parameters.setdefault("properties", {})
            description = str(
                getattr(tool, "description", None) or f"Call {original_name}"
            )
            definitions.append(
                ToolDefinition(
                    name=exposed_name,
                    description=f"[{self.config.name}] {description}",
                    parameters=parameters,
                    read_only=read_only,
                    source=f"mcp:{self.config.name}",
                )
            )
            original_names[exposed_name] = original_name
        self._original_names = original_names
        return definitions

    def definitions(self) -> list[ToolDefinition]:
        if self._definitions is not None:
            return list(self._definitions)
        if time.monotonic() < self._retry_after:
            return []
        with self._discovery_lock:
            if self._definitions is not None:
                return list(self._definitions)
            try:
                discovered = self._discover()
            except Exception as exc:
                logger.warning(
                    "MCP tool discovery failed for %s: %s", self.config.name, exc
                )
                self._retry_after = (
                    time.monotonic() + self._FAILED_DISCOVERY_RETRY_SECONDS
                )
                return []
            if not discovered:
                self._retry_after = (
                    time.monotonic() + self._FAILED_DISCOVERY_RETRY_SECONDS
                )
                return []
            self._definitions = discovered
            return list(discovered)

    async def _call_tool(self, name: str, arguments: dict[str, Any]):
        timeout = timedelta(seconds=self.config.timeout_seconds)
        async with stdio_client(self._server_parameters()) as streams:
            async with ClientSession(
                *streams,
                read_timeout_seconds=timeout,
            ) as session:
                await session.initialize()
                return await session.call_tool(name, arguments)

    def _normalize_result(self, original_name: str, result: Any) -> dict[str, Any]:
        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            payload: Any = structured
        else:
            content = getattr(result, "content", []) or []
            text_parts = [
                str(getattr(item, "text", ""))
                for item in content
                if getattr(item, "text", None) is not None
            ]
            joined = "\n".join(part for part in text_parts if part)
            try:
                payload = json.loads(joined) if joined else {}
            except json.JSONDecodeError:
                payload = {"content": joined}
        if not isinstance(payload, dict):
            payload = {"value": payload}
        envelope = {
            "source": f"mcp:{self.config.name}",
            "tool": original_name,
            **payload,
        }
        if bool(getattr(result, "isError", False)):
            detail = envelope.get("error") or envelope.get("content") or payload
            return {"error": str(detail)}
        serialized = json.dumps(envelope, ensure_ascii=False, default=str)
        if len(serialized) > self.config.max_result_chars:
            return {
                "source": f"mcp:{self.config.name}",
                "tool": original_name,
                "truncated": True,
                "content": serialized[: self.config.max_result_chars],
            }
        return envelope

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name not in self._original_names:
            self.definitions()
        original_name = self._original_names.get(name)
        if original_name is None:
            return {"error": f"tool is not available: {name}"}
        try:
            result = asyncio.run(self._call_tool(original_name, arguments))
            return self._normalize_result(original_name, result)
        except Exception as exc:
            return {"error": f"{self.config.name} MCP call failed: {exc}"}

    def instructions(self) -> str:
        if not self._command_available():
            return ""
        return self.config.instructions
