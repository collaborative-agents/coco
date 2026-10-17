from __future__ import annotations

import json
from datetime import UTC, datetime

from proactive_tutor.tools.native import NativeToolProvider
from screen_context import AccessibilityPermissionError, CaptureRequest
from screen_context.models import (
    CaptureQuality,
    ContextField,
    EditingContent,
    EditingContext,
    EditingState,
    ScreenContextSnapshot,
    SourceInfo,
    TargetInfo,
    TextRange,
)


async def _get_user_context(**_arguments):
    return {}


async def _get_recent_observations(**_arguments):
    return {}


class _EditingContextProvider:
    name = "test_accessibility"

    def __init__(self) -> None:
        self.requests: list[CaptureRequest] = []

    def capture(self, request: CaptureRequest) -> ScreenContextSnapshot:
        self.requests.append(request)
        text = "Hello team,\n\nHere is the project update."
        return ScreenContextSnapshot(
            captured_at=datetime(2026, 8, 29, tzinfo=UTC),
            source=SourceInfo(
                type=self.name,
                platform="test",
                coordinate_space="test_points",
                capture_duration_ms=1,
            ),
            target=TargetInfo(
                pid=42,
                application_name="Slack",
                window_title="Message #project",
            ),
            editing=EditingState(
                detected=True,
                role="AXTextArea",
                name="Message",
                focused=True,
                editable=True,
                selection=TextRange(location=12, length=0),
                selected_text="team",
                content=EditingContent(
                    text=text,
                    reported_character_count=len(text),
                    returned_python_character_count=len(text),
                    returned_utf16_code_unit_count=len(text),
                    coverage="complete_control_text",
                    provenance="test",
                ),
            ),
            context=EditingContext(
                active_document="#project",
                fields=[
                    ContextField(
                        role="AXTextField",
                        label="Subject",
                        value="Project update",
                    ),
                    ContextField(
                        role="AXSecureTextField",
                        label="Password",
                        secure=True,
                    ),
                ],
                coverage="bounded_ancestor_subtree",
            ),
            quality=CaptureQuality(),
            diagnostics={"raw_ax_value": "must not reach the model"},
        )


class _PermissionDeniedProvider:
    name = "test_accessibility"

    def capture(self, _request: CaptureRequest) -> ScreenContextSnapshot:
        raise AccessibilityPermissionError("Accessibility access is missing")


def _provider(editing_context_provider) -> NativeToolProvider:
    return NativeToolProvider(
        enable_memory=False,
        enable_screen=False,
        enable_editing_context=True,
        editing_context_provider=editing_context_provider,
        screen_observer=lambda _focus: {},
        get_user_context=_get_user_context,
        get_recent_observations=_get_recent_observations,
    )


def test_active_editing_context_is_exposed_as_read_only_native_tool() -> None:
    definition = _provider(_EditingContextProvider()).definitions()[0]

    assert definition.name == "get_active_editing_context"
    assert definition.read_only is True
    assert definition.source == "native_editing_context"
    assert definition.parameters["properties"]["max_characters"]["maximum"] == 20_000


def test_active_editing_context_returns_prompt_safe_projection() -> None:
    editing_provider = _EditingContextProvider()
    provider = _provider(editing_provider)

    result = provider.execute(
        "get_active_editing_context",
        {"application": "Slack", "max_characters": 8_000},
    )

    request = editing_provider.requests[0]
    assert request.application == "Slack"
    assert request.max_text_characters == 8_000
    assert request.enable_manual_accessibility is True
    assert result["source"] == "test_accessibility"
    assert result["application"] == "Slack"
    assert result["editing"]["text"]["content"].startswith("Hello team")
    assert result["coverage"] == {
        "control_text": "complete_control_text",
        "application_document": "unknown",
        "reported_characters": 40,
        "returned_characters": 40,
    }
    serialized = json.dumps(result)
    assert "must not reach the model" not in serialized
    assert "raw_ax_value" not in serialized
    assert "Password" in serialized


def test_active_editing_context_validates_bounds() -> None:
    provider = _provider(_EditingContextProvider())

    assert provider.execute(
        "get_active_editing_context", {"max_characters": 20_001}
    ) == {"error": "max_characters must be between 1 and 20000"}
    assert provider.execute("get_active_editing_context", {"application": ""}) == {
        "error": "application must be a non-empty string or null"
    }


def test_active_editing_context_returns_structured_permission_error() -> None:
    result = _provider(_PermissionDeniedProvider()).execute(
        "get_active_editing_context",
        {},
    )

    assert result == {
        "error": "Accessibility access is missing",
        "error_code": "accessibility_permission_required",
    }


def test_active_editing_context_instructions_limit_sensitive_access() -> None:
    instructions = _provider(_EditingContextProvider()).instructions()

    assert "explicitly refers to text" in instructions
    assert "Do not save captured draft text to memory" in instructions
    assert "Secure fields are redacted" in instructions
