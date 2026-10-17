from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from proactive_tutor.tools.base import ToolDefinition, ToolProvider, object_schema
from screen_context import (
    AccessibilityPermissionError,
    CaptureRequest,
    ScreenContextProvider,
    project_for_reasoning,
)
from screen_context.providers import MacOSAXProvider


def _default_editing_context_provider() -> ScreenContextProvider | None:
    provider = MacOSAXProvider()
    return provider if provider.available else None


class NativeToolProvider(ToolProvider):
    """Coco-owned screen, active-editing, and memory tools."""

    def __init__(
        self,
        *,
        enable_memory: bool,
        enable_screen: bool,
        screen_observer: Callable[[str], dict[str, Any]],
        get_user_context: Callable[..., Awaitable[dict[str, Any]]],
        get_recent_observations: Callable[..., Awaitable[dict[str, Any]]],
        enable_editing_context: bool | None = None,
        editing_context_provider: ScreenContextProvider | None = None,
    ):
        self.enable_memory = enable_memory
        self.enable_screen = enable_screen
        self.enable_editing_context = (
            enable_screen if enable_editing_context is None else enable_editing_context
        )
        self._screen_observer = screen_observer
        self._get_user_context = get_user_context
        self._get_recent_observations = get_recent_observations
        self._editing_context_provider = editing_context_provider
        if self.enable_editing_context and self._editing_context_provider is None:
            self._editing_context_provider = _default_editing_context_provider()

    def definitions(self) -> list[ToolDefinition]:
        definitions: list[ToolDefinition] = []
        nullable_string = {"type": ["string", "null"]}
        if self.enable_screen:
            definitions.append(
                ToolDefinition(
                    name="observe_screen",
                    description=(
                        "Inspect the user's current screen when the request needs "
                        "visual context that was not attached to the conversation."
                    ),
                    parameters=object_schema(
                        {
                            "focus": {
                                "type": "string",
                                "description": (
                                    "Concise description of visual evidence needed."
                                ),
                            }
                        },
                        ["focus"],
                    ),
                )
            )
        if self.enable_editing_context and self._editing_context_provider is not None:
            definitions.append(
                ToolDefinition(
                    name="get_active_editing_context",
                    description=(
                        "Read the text, selection, document, and nearby fields "
                        "exposed by the currently focused editor. Use when the user "
                        "asks for help with a draft they are actively editing."
                    ),
                    parameters=object_schema(
                        {
                            "application": {
                                "type": ["string", "null"],
                                "description": (
                                    "Optional exact application name or bundle ID, "
                                    "such as 'Slack' or 'Google Chrome'. Omit to "
                                    "inspect the frontmost application."
                                ),
                            },
                            "max_characters": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 20_000,
                                "default": 12_000,
                                "description": (
                                    "Maximum exposed editor characters returned."
                                ),
                            },
                        }
                    ),
                    source="native_editing_context",
                )
            )
        if self.enable_memory:
            definitions.extend(
                [
                    ToolDefinition(
                        name="get_user_context",
                        description=(
                            "Retrieve relevance-ranked, synthesized long-term user "
                            "context. Use an empty query for recent memory."
                        ),
                        parameters=object_schema(
                            {
                                "query": {"type": "string"},
                                "start_hh_mm_ago": nullable_string,
                                "end_hh_mm_ago": nullable_string,
                                "limit": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 20,
                                },
                                "evidence_limit": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 5,
                                },
                            },
                            ["query"],
                        ),
                    ),
                    ToolDefinition(
                        name="get_recent_observations",
                        description=(
                            "Retrieve newest raw activity observations in reverse "
                            "chronological order."
                        ),
                        parameters=object_schema(
                            {
                                "limit": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 50,
                                },
                                "start_hh_mm_ago": nullable_string,
                                "end_hh_mm_ago": nullable_string,
                                "session_id": nullable_string,
                                "observation_type": nullable_string,
                            }
                        ),
                    ),
                ]
            )
        return definitions

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "observe_screen" and self.enable_screen:
                focus = str(arguments.get("focus") or "").strip()
                if not focus:
                    return {"error": "focus is required"}
                return self._screen_observer(focus)
            if (
                name == "get_active_editing_context"
                and self.enable_editing_context
                and self._editing_context_provider is not None
            ):
                application = arguments.get("application")
                if application is not None:
                    if not isinstance(application, str) or not application.strip():
                        return {
                            "error": "application must be a non-empty string or null"
                        }
                    application = application.strip()
                max_characters = arguments.get("max_characters", 12_000)
                if isinstance(max_characters, bool) or not isinstance(
                    max_characters, int
                ):
                    return {"error": "max_characters must be an integer"}
                if not 1 <= max_characters <= 20_000:
                    return {"error": "max_characters must be between 1 and 20000"}
                snapshot = self._editing_context_provider.capture(
                    CaptureRequest(
                        application=application,
                        max_text_characters=max_characters,
                        include_editing_context=True,
                        # Chromium/Electron may not expose its editor tree until
                        # manual accessibility is enabled. The macOS provider
                        # restores the prior value after this read-only capture.
                        enable_manual_accessibility=True,
                        prompt_for_permission=False,
                    )
                )
                reasoning = project_for_reasoning(
                    snapshot,
                    max_text_characters=max_characters,
                ).to_prompt_dict()
                content = snapshot.editing.content
                return {
                    "source": self._editing_context_provider.name,
                    **reasoning,
                    "coverage": {
                        "control_text": content.coverage,
                        "application_document": (content.application_document_complete),
                        "reported_characters": content.reported_character_count,
                        "returned_characters": (
                            content.returned_python_character_count
                        ),
                    },
                }
            if name == "get_user_context" and self.enable_memory:
                return asyncio.run(self._get_user_context(**{"query": "", **arguments}))
            if name == "get_recent_observations" and self.enable_memory:
                return asyncio.run(self._get_recent_observations(**arguments))
            return {"error": f"tool is not available: {name}"}
        except AccessibilityPermissionError as exc:
            return {
                "error": str(exc),
                "error_code": "accessibility_permission_required",
            }
        except (TypeError, ValueError, OSError, RuntimeError, httpx.HTTPError) as exc:
            return {"error": str(exc)}

    def instructions(self) -> str:
        parts: list[str] = []
        if self.enable_screen:
            parts.append(
                """
- Use observe_screen only when the user's request requires current visual context, such as "what is on my screen?", "help me with this", or a reference to a visible UI without an attached image.
- Do not inspect the screen for general questions or when the conversation already contains enough context.
- focus is a concise description of what visual evidence is needed. The sensing observer receives it as its inspection task.
- IMPORTANT: when the current user message includes an attached screenshot, treat that image as the screen state the user deliberately chose to share. Use it as the primary visual context and do not call observe_screen merely to inspect the same content again. Only request a new live-screen observation if the user explicitly asks for an updated/current view after the attachment was captured.
"""
            )
        if self.enable_editing_context and self._editing_context_provider is not None:
            parts.append(
                """
- Use get_active_editing_context only when the user explicitly refers to text they are currently drafting or asks for help with the focused editor. Do not inspect drafts for unrelated questions.
- Omit application to inspect the frontmost app. When the user explicitly names an app and Coco may have taken focus, pass its exact application name or bundle ID.
- Treat coverage.control_text as the completeness of the exposed UI control, not proof that the entire underlying application document was returned. State limitations when text is truncated, unavailable, or of unknown completeness.
- Secure fields are redacted. Never ask for or infer their contents. Do not save captured draft text to memory unless the user explicitly requests it.
"""
            )
        if self.enable_memory:
            parts.append(
                """
- Use memory tools only when the supplied conversation does not provide enough factual context, or when the user asks about earlier activity.
- Use get_user_context for synthesized, relevance-ranked long-term propositions.
- Use get_recent_observations for newest raw activity in reverse chronological order. Prefer a small limit and narrow time window because raw observations are sensitive and token-heavy.
- An empty query returns recent memory propositions. query is a concise lexical search string.
- Relative time boundaries use HH:MM before now. start_hh_mm_ago is the older boundary and end_hh_mm_ago is the newer boundary. Either may be null.
- get_user_context limit must be between 1 and 20; get_recent_observations limit must be between 1 and 50. evidence_limit must be between 0 and 5.
- confidence is evidence strength, durability is expected persistence, and score is retrieval relevance after time decay.
"""
            )
        if not parts:
            return ""
        return (
            "\n".join(parts)
            + "\n- Current-screen, editing, and memory data are sensitive. Request "
            "them only when necessary and never invent details absent from a tool result."
        )
