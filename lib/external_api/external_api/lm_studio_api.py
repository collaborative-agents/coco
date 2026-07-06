"""Synchronous wrapper around the LM Studio Python SDK with multimodal input support.

Images can be provided as:
  * a local filesystem path (str / PathLike)
  * an http(s):// URL (fetched eagerly via httpx)
  * a base64 data URI ("data:image/png;base64,...")

The LM Studio server must be running locally (or reachable) and the named
model must already be loaded — this wrapper does not download or load models.
```
Make sure both server and laptop start the LM Studio server
```
lms login
lms link enable
lms server start
lms load nvidia/nemotron-3-nano-omni
```
"""

import base64
import io
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

import httpx
import lmstudio as lms
from external_api.types import TokenUsage
from pydantic import BaseModel

logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageContent(BaseModel):
    """Image input. ``source`` may be a local path, http(s) URL, or data URI."""

    type: Literal["image"] = "image"
    source: str


ContentBlock = TextContent | ImageContent


class LMStudioMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock]


_DATA_URI_PREFIX = "data:"


def _load_image_handle(client: lms.Client, source: str) -> lms.FileHandle:
    """Resolve an ImageContent.source into an LM Studio FileHandle."""
    if source.startswith(_DATA_URI_PREFIX):
        # Expected form: data:<mediatype>[;base64],<payload>
        try:
            header, payload = source.split(",", 1)
        except ValueError as exc:
            raise ValueError(f"Malformed data URI for image: {source[:40]}...") from exc
        if ";base64" not in header:
            raise ValueError("Only base64-encoded data URIs are supported for images")
        data = base64.b64decode(payload)
        return client.prepare_image(io.BytesIO(data))

    if source.startswith(("http://", "https://")):
        # LM Studio's prepare_image needs bytes — fetch the URL up front.
        response = httpx.get(source, timeout=30.0, follow_redirects=True)
        response.raise_for_status()
        return client.prepare_image(io.BytesIO(response.content))

    path = Path(source).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Image source not found on disk: {path}")
    return client.prepare_image(str(path))


def _build_chat(client: lms.Client, messages: Sequence[LMStudioMessage]) -> lms.Chat:
    chat = lms.Chat()
    for message in messages:
        text_parts: list[str] = []
        image_handles: list[lms.FileHandle] = []
        for block in message.content:
            if isinstance(block, TextContent):
                text_parts.append(block.text)
            else:
                image_handles.append(_load_image_handle(client, block.source))

        text = "\n".join(text_parts)

        if message.role == "system":
            if image_handles:
                raise ValueError("System messages cannot contain images")
            chat.add_system_prompt(text)
        elif message.role == "user":
            # add_user_message requires non-empty content; provide a hint when only
            # images were supplied so the model still sees a textual cue.
            if not text and image_handles:
                text = "(see attached image)"
            chat.add_user_message(text, images=image_handles)
        elif message.role == "assistant":
            if image_handles:
                raise ValueError("Assistant messages cannot contain images")
            chat.add_assistant_response(text)
        else:  # pragma: no cover — Literal narrows this
            raise ValueError(f"Unsupported role: {message.role}")
    return chat


def get_lm_studio_completion(
    messages: Sequence[LMStudioMessage],
    model: str = "nvidia/nemotron-3-nano-omni",
    host: str = "localhost:1234",
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
) -> tuple[LMStudioMessage, TokenUsage]:
    """Get a completion from a model hosted by LM Studio.

    Doc: https://lmstudio.ai/docs/python

    The named ``model`` must already be loaded in LM Studio (this wrapper
    doesn't trigger downloads). ``host`` is a ``host:port`` string for the
    LM Studio server. Sampling parameters left as ``None`` defer to whatever
    LM Studio / the model preset configured.
    """
    config: lms.LlmPredictionConfigDict = {}
    if temperature is not None:
        config["temperature"] = temperature
    if max_tokens is not None:
        config["maxTokens"] = max_tokens
    if top_p is not None:
        config["topPSampling"] = top_p

    with lms.Client(host) as client:
        chat = _build_chat(client, messages)
        llm = client.llm.model(model)
        result = llm.respond(chat, config=config if config else None)

    output = LMStudioMessage(
        role="assistant",
        content=[TextContent(text=result.content)],
    )
    stats = result.stats
    usage = TokenUsage(
        prompt_tokens=getattr(stats, "prompt_tokens_count", 0) or 0,
        completion_tokens=getattr(stats, "predicted_tokens_count", 0) or 0,
        # LM Studio doesn't expose prompt-cache hit / creation counters, so
        # surface zeros to keep the TokenUsage shape consistent with other
        # providers in this package.
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    return output, usage
