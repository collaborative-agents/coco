import logging
from collections.abc import Callable, Sequence
from typing import Any, Literal

from external_api.types import TokenUsage
from litellm import completion
from pydantic import BaseModel, Field

# Silence INFO logs from the litellm library only
logging.getLogger("LiteLLM").setLevel(logging.WARNING)


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageURL(BaseModel):
    url: str


class ImageURLContent(BaseModel):
    type: Literal["image_url"] = "image_url"
    image_url: ImageURL = Field(..., alias="image_url")


ContentBlock = TextContent | ImageURLContent


class LiteLLMMessage(BaseModel):
    role: str  # "user", "assistant", "system"
    content: list[ContentBlock]


def get_litellm_completion(
    messages: Sequence[LiteLLMMessage | dict],
    model: str = "anthropic/claude-sonnet-4-20250514",
    temperature: float = 1.0,
    max_tokens: int | None = None,
    top_p: float | None = None,
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "default"]
    | None = None,
    extra_body: dict[str, Any] | None = None,
    stream: bool = False,
    on_chunk: Callable[[str], None] | None = None,
) -> tuple[LiteLLMMessage, TokenUsage]:
    """
    Get completion from LiteLLM API.

    Doc: https://docs.litellm.ai/docs
    """
    kwargs: dict = {
        "model": model,
        "messages": [
            message.model_dump() if isinstance(message, LiteLLMMessage) else message
            for message in messages
        ],
        "temperature": temperature,
        "stream": stream,
    }
    # max_tokens is required by some providers (e.g. Anthropic); only include
    # it when explicitly provided so providers with built-in defaults aren't
    # forced into a None value that their API rejects.
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    # reasoning_effort and top_p are optional — omit them when not set to
    # avoid passing unsupported parameters to providers that don't accept them.
    if reasoning_effort is not None:
        kwargs["reasoning_effort"] = reasoning_effort
    if top_p is not None:
        kwargs["top_p"] = top_p
    if extra_body is not None:
        kwargs["extra_body"] = extra_body
    if stream:
        kwargs["stream_options"] = {"include_usage": True}

    response = completion(**kwargs)
    if stream:
        text_parts: list[str] = []
        usage_data: Any = {}
        for chunk in response:
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage_data = chunk_usage
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            content = getattr(delta, "content", None) if delta is not None else None
            if content:
                text_parts.append(content)
                if on_chunk is not None:
                    on_chunk(content)
        raw_content = "".join(text_parts)
    else:
        # print(f"Raw LiteLLM response: {response}")
        raw_content = response["choices"][0]["message"]["content"]  # type: ignore
        usage_data = response["usage"]  # type: ignore
    # Thinking models (e.g. gemini-2.5-pro) may return None for the visible
    # content field when only reasoning tokens are emitted.  Fall back to the
    # reasoning_content field so callers always get a non-empty string.
    if raw_content is None:
        raw_content = (
            getattr(response["choices"][0]["message"], "reasoning_content", None)  # type: ignore
            or ""
        )

    output = LiteLLMMessage(
        role="assistant",
        content=[TextContent(text=raw_content)],
    )

    def usage_value(name: str) -> int:
        value = getattr(usage_data, name, None)
        if value is not None:
            return int(value or 0)
        if isinstance(usage_data, dict):
            return int(usage_data.get(name, 0) or 0)
        return 0

    usage = TokenUsage(
        completion_tokens=usage_value("completion_tokens"),
        prompt_tokens=usage_value("prompt_tokens"),
        cache_creation_input_tokens=usage_value("cache_creation_input_tokens"),
        cache_read_input_tokens=usage_value("cache_read_input_tokens"),
    )

    return output, usage
