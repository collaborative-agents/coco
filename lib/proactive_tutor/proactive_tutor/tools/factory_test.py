from __future__ import annotations

import pytest
from proactive_tutor.tools.factory import _google_calendar_provider


def test_google_calendar_provider_defaults_to_read_only_mcp_server(
    monkeypatch,
) -> None:
    monkeypatch.delenv("COCO_GOOGLE_CALENDAR_MCP_COMMAND", raising=False)
    monkeypatch.delenv("COCO_GOOGLE_CALENDAR_MCP_ARGS", raising=False)

    config = _google_calendar_provider().config

    assert config.command == "google-calendar-mcp"
    assert config.args == ()
    assert config.name_prefix == "google_calendar_"
    assert config.include_tools == config.read_only_tools
    assert "create-event" not in config.include_tools
    assert "delete-event" not in config.include_tools
    assert config.env["ENABLED_TOOLS"] == ",".join(config.include_tools)


def test_google_calendar_provider_accepts_custom_local_command(
    monkeypatch,
) -> None:
    monkeypatch.setenv("COCO_GOOGLE_CALENDAR_MCP_COMMAND", "/opt/mcp/calendar")
    monkeypatch.setenv("COCO_GOOGLE_CALENDAR_MCP_ARGS", '["--stdio"]')

    config = _google_calendar_provider().config

    assert config.command == "/opt/mcp/calendar"
    assert config.args == ("--stdio",)


def test_google_calendar_provider_rejects_non_array_args(monkeypatch) -> None:
    monkeypatch.setenv("COCO_GOOGLE_CALENDAR_MCP_ARGS", "--stdio")

    with pytest.raises(
        ValueError,
        match="COCO_GOOGLE_CALENDAR_MCP_ARGS must contain a JSON string array",
    ):
        _google_calendar_provider()
