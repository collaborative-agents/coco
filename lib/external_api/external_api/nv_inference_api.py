"""Synchronous wrapper around NVIDIA InferenceHub.

InferenceHub exposes an OpenAI-compatible API, so this module talks to it
through the official ``openai`` Python SDK pointed at the InferenceHub base.
"""

import logging
import os
from collections.abc import Callable, Sequence
from typing import Literal

from external_api.types import TokenUsage
from openai import OpenAI
from pydantic import BaseModel, Field

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("openai").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://inference-api.nvidia.com/v1/"


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageURL(BaseModel):
    url: str


class ImageURLContent(BaseModel):
    """Image input. ``url`` may be an http(s) URL or a base64 data URI."""

    type: Literal["image_url"] = "image_url"
    image_url: ImageURL = Field(..., alias="image_url")


ContentBlock = TextContent | ImageURLContent


class NVInferenceMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock]


def _normalize_message_content(msg: dict) -> dict:
    """Collapse all-text content into a plain string for the request payload.

    The OpenAI chat schema allows a message ``content`` to be either a string or
    an array of typed parts. Some InferenceHub-hosted models (e.g.
    ``nvidia/nvidia/nemotron-nano-12b-v2-vl``) validate the ``system`` message's
    ``content`` strictly as a *string* and reject the single-element
    ``[{"type": "text", ...}]`` array our message builders emit. Sending the
    canonical string form is accepted by every OpenAI-compatible backend, so
    this normalization is safe for all models. Multimodal messages (any image /
    video part) keep their array form untouched.
    """
    content = msg.get("content")
    if (
        isinstance(content, list)
        and content
        and all(isinstance(b, dict) and b.get("type") == "text" for b in content)
    ):
        return {**msg, "content": "\n".join(b.get("text", "") for b in content)}
    return msg


def _resolve_api_key(api_key: str | None) -> str:
    key = api_key or os.getenv("NV_INFERENCE_API_KEY")
    if not key:
        raise ValueError(
            "No API key provided. Pass api_key=... or set the "
            "NV_INFERENCE_API_KEY environment variable."
        )
    return key


def get_nv_inference_completion(
    messages: Sequence[NVInferenceMessage | dict],
    model: str,
    api_key: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
    stream: bool = False,
    on_chunk: Callable[[str], None] | None = None,
) -> tuple[NVInferenceMessage, TokenUsage]:
    """Get a completion from a model hosted by NVIDIA InferenceHub.

    InferenceHub is OpenAI-compatible, so ``messages`` follow the OpenAI chat
    format. They may be ``NVInferenceMessage`` instances (with text and/or
    image content blocks) or raw OpenAI-style dicts.

    Sampling parameters left as ``None`` defer to the model's defaults. When
    ``stream`` is ``True`` the response is consumed incrementally; pass
    ``on_chunk`` to receive each delta of text as it arrives. Regardless of
    streaming, the accumulated assistant message and token usage are returned.
    """
    client = OpenAI(base_url=base_url, api_key=_resolve_api_key(api_key))

    payload_messages = [
        _normalize_message_content(
            message.model_dump(by_alias=True)
            if isinstance(message, NVInferenceMessage)
            else message
        )
        for message in messages
    ]

    kwargs: dict = {
        "model": model,
        "messages": payload_messages,
        "stream": stream,
    }
    # Only include sampling parameters that were explicitly provided so the
    # model's own defaults apply otherwise.
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if top_p is not None:
        kwargs["top_p"] = top_p

    if stream:
        # Ask for usage stats on the final chunk (OpenAI streaming extension).
        kwargs["stream_options"] = {"include_usage": True}
        text_parts: list[str] = []
        usage_obj = None
        for chunk in client.chat.completions.create(**kwargs):
            if chunk.usage is not None:
                usage_obj = chunk.usage
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta is not None:
                text_parts.append(delta)
                if on_chunk is not None:
                    on_chunk(delta)
        content = "".join(text_parts)
    else:
        response = client.chat.completions.create(**kwargs)
        content = response.choices[0].message.content or ""
        usage_obj = response.usage

    output = NVInferenceMessage(
        role="assistant",
        content=[TextContent(text=content)],
    )
    usage = TokenUsage(
        prompt_tokens=getattr(usage_obj, "prompt_tokens", 0) or 0,
        completion_tokens=getattr(usage_obj, "completion_tokens", 0) or 0,
        # InferenceHub doesn't expose prompt-cache counters, so surface zeros
        # to keep the TokenUsage shape consistent with other providers.
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    return output, usage
