from __future__ import annotations

from types import SimpleNamespace

from proactive_tutor.tools.mcp import MCPServerConfig, MCPToolProvider


def _tool(
    name: str,
    *,
    read_only_hint: bool = False,
    description: str | None = None,
):
    annotations = SimpleNamespace(readOnlyHint=True) if read_only_hint else None
    return SimpleNamespace(
        name=name,
        description=description,
        inputSchema={
            "type": "object",
            "properties": {"calendarId": {"type": "string"}},
            "required": ["calendarId"],
        },
        annotations=annotations,
    )


def _provider() -> MCPToolProvider:
    return MCPToolProvider(
        MCPServerConfig(
            name="google_calendar",
            command="fake-gws",
            include_tools=("calendar_*",),
            read_only_tools=("calendar_*_get", "calendar_*_list"),
            name_prefix="google_",
        )
    )


def test_mcp_discovery_filters_mutations_and_prefixes_names(monkeypatch) -> None:
    provider = _provider()

    async def fake_list_tools():
        return [
            _tool("calendar_events_list", description="List events"),
            _tool("calendar_events_insert", description="Insert event"),
            _tool("drive_files_list", read_only_hint=True),
        ]

    monkeypatch.setattr(provider, "_command_available", lambda: True)
    monkeypatch.setattr(provider, "_list_tools", fake_list_tools)

    definitions = provider.definitions()

    assert [definition.name for definition in definitions] == [
        "google_calendar_events_list"
    ]
    assert definitions[0].source == "mcp:google_calendar"
    assert definitions[0].read_only is True
    assert definitions[0].parameters["required"] == ["calendarId"]


def test_mcp_execute_uses_original_name_and_structured_result(monkeypatch) -> None:
    provider = _provider()
    calls = []

    async def fake_list_tools():
        return [_tool("calendar_events_list")]

    async def fake_call_tool(name, arguments):
        calls.append((name, arguments))
        return SimpleNamespace(
            structuredContent={"items": [{"summary": "Project sync"}]},
            content=[],
            isError=False,
        )

    monkeypatch.setattr(provider, "_command_available", lambda: True)
    monkeypatch.setattr(provider, "_list_tools", fake_list_tools)
    monkeypatch.setattr(provider, "_call_tool", fake_call_tool)
    provider.definitions()

    result = provider.execute(
        "google_calendar_events_list",
        {"calendarId": "primary"},
    )

    assert calls == [("calendar_events_list", {"calendarId": "primary"})]
    assert result == {
        "source": "mcp:google_calendar",
        "tool": "calendar_events_list",
        "items": [{"summary": "Project sync"}],
    }


def test_mcp_execute_parses_text_json_and_contains_server_errors(monkeypatch) -> None:
    provider = _provider()

    async def fake_list_tools():
        return [_tool("calendar_events_get")]

    async def fake_call_tool(name, arguments):
        return SimpleNamespace(
            structuredContent=None,
            content=[SimpleNamespace(text='{"error": "not authorized"}')],
            isError=True,
        )

    monkeypatch.setattr(provider, "_command_available", lambda: True)
    monkeypatch.setattr(provider, "_list_tools", fake_list_tools)
    monkeypatch.setattr(provider, "_call_tool", fake_call_tool)
    provider.definitions()

    assert provider.execute(
        "google_calendar_events_get",
        {"calendarId": "primary"},
    ) == {"error": "not authorized"}


def test_mcp_is_dormant_when_command_is_not_installed(monkeypatch) -> None:
    provider = _provider()
    monkeypatch.setattr(provider, "_command_available", lambda: False)

    assert provider.definitions() == []
    assert provider.instructions() == ""


def test_mcp_subprocess_receives_only_allowlisted_environment(monkeypatch) -> None:
    provider = MCPToolProvider(
        MCPServerConfig(
            name="calendar",
            command="calendar-mcp",
            env={"SERVER_SETTING": "read-only"},
            forward_env=("CALENDAR_CREDENTIALS",),
        )
    )
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("CALENDAR_CREDENTIALS", "/safe/credentials.json")
    monkeypatch.setenv("UNRELATED_LLM_API_KEY", "must-not-leak")

    child_env = provider._server_parameters().env

    assert child_env is not None
    assert child_env["PATH"] == "/usr/bin"
    assert child_env["CALENDAR_CREDENTIALS"] == "/safe/credentials.json"
    assert child_env["SERVER_SETTING"] == "read-only"
    assert "UNRELATED_LLM_API_KEY" not in child_env
