from __future__ import annotations

from typing import Any

import pytest
from proactive_tutor.tools.base import (
    CompositeToolProvider,
    ToolDefinition,
    ToolProvider,
    object_schema,
)


class _Provider(ToolProvider):
    def __init__(self, definition: ToolDefinition):
        self.definition = definition
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def definitions(self) -> list[ToolDefinition]:
        return [self.definition]

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, arguments))
        return {"ok": True, "arguments": arguments}

    def instructions(self) -> str:
        return f"Use {self.definition.name} sparingly."


def _definition(name: str = "lookup", *, read_only: bool = True) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description="Look something up.",
        parameters=object_schema(
            {"query": {"type": "string"}},
            ["query"],
        ),
        read_only=read_only,
    )


def test_composite_routes_and_validates_tool_calls() -> None:
    provider = _Provider(_definition())
    composite = CompositeToolProvider([provider])

    assert composite.execute("lookup", {"query": "schedule"}) == {
        "ok": True,
        "arguments": {"query": "schedule"},
    }
    assert provider.calls == [("lookup", {"query": "schedule"})]
    assert composite.execute("lookup", {}) == {
        "error": "missing required arguments: query"
    }
    assert composite.execute("lookup", {"query": "x", "path": "/tmp"}) == {
        "error": "unexpected arguments: path"
    }
    assert composite.execute("missing", {}) == {
        "error": "tool is not available: missing"
    }


def test_composite_rejects_mutations_until_approval_is_supported() -> None:
    provider = _Provider(_definition("create_event", read_only=False))
    composite = CompositeToolProvider([provider])

    result = composite.execute("create_event", {"query": "meeting"})

    assert result == {
        "error": "tool requires user approval, which is not available yet"
    }
    assert provider.calls == []


def test_composite_rejects_duplicate_tool_names() -> None:
    composite = CompositeToolProvider(
        [_Provider(_definition()), _Provider(_definition())]
    )

    with pytest.raises(ValueError, match="duplicate tool name: lookup"):
        composite.definitions()


def test_function_tool_shape_and_provider_instructions() -> None:
    provider = _Provider(_definition())
    composite = CompositeToolProvider([provider])

    assert composite.definitions()[0].as_function_tool() == {
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "Look something up.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    }
    assert composite.instructions() == "Use lookup sparingly."
