"""Synchronous wrapper around Tinfoil (``tinfoil`` Python SDK).

Tinfoil provides *confidential inference*: prompts are served from hardware
enclaves (confidential VMs / TEEs) whose code is remotely attested, so the
host running the model can't read the plaintext — useful when the payload is
sensitive, as with screen-observation prompts.

The Tinfoil client (``TinfoilAI``) is a drop-in of the OpenAI client: it
auto-selects a router enclave, verifies its attestation against the published
GitHub build, and then speaks the ordinary OpenAI chat API. So this wrapper
mirrors :mod:`external_api.oa_api` — same message shapes, same streaming
handling — differing only in how the client is constructed and that the
``tinfoil`` package is imported lazily (it's an optional install).

See https://github.com/tinfoilsh/tinfoil-python.
"""

import logging
import os
from collections.abc import Sequence
from typing import Any, Literal

from external_api.types import TokenUsage
from pydantic import BaseModel, Field

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("openai").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


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


class TinfoilMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock]


def _import_tinfoil():
    """Import the optional ``tinfoil`` SDK, with an actionable error if missing."""
    try:
        from tinfoil import TinfoilAI  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise ImportError(
            "The 'tinfoil' package is required for Tinfoil confidential "
            "inference. Install it with `uv pip install tinfoil`."
        ) from exc
    return TinfoilAI


def _resolve_api_key(api_key: str | None) -> str:
    key = api_key or os.getenv("TINFOIL_API_KEY")
    if not key:
        raise ValueError(
            "No API key provided. Pass api_key=... or set the "
            "TINFOIL_API_KEY environment variable."
        )
    return key


def _normalize_message_content(msg: dict) -> dict:
    """Collapse all-text content into a plain string for the request payload.

    The OpenAI chat schema allows a message ``content`` to be either a string or
    an array of typed parts. Some models validate a ``system`` message's
    ``content`` strictly as a *string* and reject the single-element
    ``[{"type": "text", ...}]`` array our message builders emit. Sending the
    canonical string form is accepted by every OpenAI-compatible backend, so
    this normalization is safe for all models. Multimodal messages (any image
    part) keep their array form untouched.
    """
    content = msg.get("content")
    if (
        isinstance(content, list)
        and content
        and all(isinstance(b, dict) and b.get("type") == "text" for b in content)
    ):
        return {**msg, "content": "\n".join(b.get("text", "") for b in content)}
    return msg


def get_tinfoil_completion(
    messages: Sequence[TinfoilMessage | dict],
    model: str,
    api_key: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
) -> tuple[TinfoilMessage, TokenUsage]:
    """Get a completion from a model served by a Tinfoil confidential enclave.

    The Tinfoil client is OpenAI-compatible, so ``messages`` follow the OpenAI
    chat format. They may be ``TinfoilMessage`` instances (with text and/or
    image content blocks) or raw OpenAI-style dicts. ``model`` is the Tinfoil
    model id (e.g. ``llama3-3-70b``). The client auto-selects and attests a
    router enclave from the API key alone.

    Sampling parameters left as ``None`` defer to the model's defaults.
    """
    TinfoilAI = _import_tinfoil()
    client = TinfoilAI(api_key=_resolve_api_key(api_key))

    payload_messages = [
        _normalize_message_content(
            message.model_dump(by_alias=True)
            if isinstance(message, TinfoilMessage)
            else message
        )
        for message in messages
    ]

    kwargs: dict[str, Any] = {
        "model": model,
        "messages": payload_messages,
    }
    # Only include sampling parameters that were explicitly provided so the
    # model's own defaults apply otherwise.
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if top_p is not None:
        kwargs["top_p"] = top_p

    response = client.chat.completions.create(**kwargs)
    content = response.choices[0].message.content or ""
    usage_obj = response.usage

    output = TinfoilMessage(
        role="assistant",
        content=[TextContent(text=content)],
    )
    usage = TokenUsage(
        prompt_tokens=getattr(usage_obj, "prompt_tokens", 0) or 0,
        completion_tokens=getattr(usage_obj, "completion_tokens", 0) or 0,
        # Tinfoil doesn't expose prompt-cache counters, so surface zeros to keep
        # the TokenUsage shape consistent with other providers.
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    return output, usage
