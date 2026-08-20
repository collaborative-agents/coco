"""OpenAI-compatible chat adapter for Tinker's hosted inference endpoint."""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any, Literal

from external_api.litellm_api import (
    FunctionCall,
    LiteLLMMessage,
    TextContent,
    ToolCall,
)
from external_api.types import TokenUsage
from openai import OpenAI

DEFAULT_TINKER_BASE_URL = (
    "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1"
)


def get_tinker_oai_completion(
    messages: Sequence[LiteLLMMessage | dict],
    *,
    model: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "default"]
    | None = None,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> tuple[LiteLLMMessage, TokenUsage]:
    api_key = os.getenv("TINKER_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("TINKER_API_KEY is not configured")
    client = OpenAI(
        base_url=os.getenv("TINKER_BASE_URL", DEFAULT_TINKER_BASE_URL),
        api_key=api_key,
    )
    request: dict[str, Any] = {
        "model": model,
        "messages": [
            message.model_dump(exclude_none=True)
            if isinstance(message, LiteLLMMessage)
            else message
            for message in messages
        ],
        "stream": False,
    }
    if temperature is not None:
        request["temperature"] = temperature
    if max_tokens is not None:
        request["max_tokens"] = max_tokens
    if reasoning_effort is not None:
        request["reasoning_effort"] = reasoning_effort
    if tools is not None:
        request["tools"] = tools
    if tool_choice is not None:
        request["tool_choice"] = tool_choice

    response = client.chat.completions.create(**request)
    message = response.choices[0].message
    output = LiteLLMMessage(
        role="assistant",
        content=[TextContent(text=message.content or "")],
        tool_calls=[
            ToolCall(
                id=call.id,
                function=FunctionCall(
                    name=call.function.name,
                    arguments=call.function.arguments or "{}",
                ),
            )
            for call in message.tool_calls or []
        ],
    )
    usage = response.usage
    return output, TokenUsage(
        prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
        completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
        cache_creation_input_tokens=0,
        cache_read_input_tokens=int(
            getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0)
            or 0
        ),
    )
