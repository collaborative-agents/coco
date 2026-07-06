import logging
from collections.abc import Sequence
from typing import Literal

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
        "stream": False,
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

    response = completion(**kwargs)
    # print(f"Raw LiteLLM response: {response}")
    raw_content = response["choices"][0]["message"]["content"]  # type: ignore
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
    usage = TokenUsage(
        completion_tokens=response["usage"].get("completion_tokens", 0),  # type: ignore
        prompt_tokens=response["usage"].get("prompt_tokens", 0),  # type: ignore
        cache_creation_input_tokens=response["usage"].get(  # type: ignore
            "cache_creation_input_tokens", 0
        ),
        cache_read_input_tokens=response["usage"].get("cache_read_input_tokens", 0),  # type: ignore
    )

    return output, usage
