from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolDefinition:
    """Provider-neutral description of one model-callable tool."""

    name: str
    description: str
    parameters: dict[str, Any]
    read_only: bool = True
    source: str = "native"

    def as_function_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def validate_arguments(self, arguments: dict[str, Any]) -> str | None:
        properties = self.parameters.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}
        if self.parameters.get("additionalProperties") is False:
            unexpected = sorted(set(arguments) - set(properties))
            if unexpected:
                return f"unexpected arguments: {', '.join(unexpected)}"
        required = self.parameters.get("required", [])
        if isinstance(required, list):
            missing = [name for name in required if name not in arguments]
            if missing:
                return f"missing required arguments: {', '.join(missing)}"
        return None


def object_schema(
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


class ToolProvider(ABC):
    """Supplies tool schemas, prompt policy, and execution for one capability."""

    @abstractmethod
    def definitions(self) -> list[ToolDefinition]:
        """Return the tools currently available to the model."""

    @abstractmethod
    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Execute one provider-owned tool and return a JSON-compatible mapping."""

    def instructions(self) -> str:
        """Return concise model-facing policy for the provider's tools."""
        return ""


class CompositeToolProvider(ToolProvider):
    """Combines providers behind one collision-checked tool namespace."""

    def __init__(self, providers: list[ToolProvider]):
        self.providers = list(providers)
        self._owners: dict[str, tuple[ToolProvider, ToolDefinition]] = {}

    def definitions(self) -> list[ToolDefinition]:
        definitions: list[ToolDefinition] = []
        owners: dict[str, tuple[ToolProvider, ToolDefinition]] = {}
        for provider in self.providers:
            for definition in provider.definitions():
                if definition.name in owners:
                    raise ValueError(f"duplicate tool name: {definition.name}")
                owners[definition.name] = (provider, definition)
                definitions.append(definition)
        self._owners = owners
        return definitions

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        owner = self._owners.get(name)
        if owner is None:
            self.definitions()
            owner = self._owners.get(name)
        if owner is None:
            return {"error": f"tool is not available: {name}"}
        provider, definition = owner
        validation_error = definition.validate_arguments(arguments)
        if validation_error:
            return {"error": validation_error}
        # This first calendar release intentionally exposes read-only tools.
        # Keep the execution boundary fail-closed if a future provider
        # accidentally advertises a mutating operation before approvals exist.
        if not definition.read_only:
            return {"error": "tool requires user approval, which is not available yet"}
        return provider.execute(name, arguments)

    def instructions(self) -> str:
        parts = [provider.instructions().strip() for provider in self.providers]
        return "\n".join(part for part in parts if part)
