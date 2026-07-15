"""Unified provider dispatcher for LLM calls.

Routes completions through LiteLLM by default, or through an alternate backend
when the model name carries a recognized prefix. This mirrors LiteLLM's own
``<provider>/<model>`` convention so the existing model knobs are enough to
switch backends — no separate flag plumbing is required:

- ``lm_studio/<model>`` -> a local LM Studio server (e.g.
  ``lm_studio/nvidia/nemotron-3-nano-omni``). Host defaults to
  ``localhost:1234``; override with ``LM_STUDIO_HOST``.
- ``oa/<model>`` -> The Open Anonymity Project unlinkable inference (e.g.
  ``oa/openai/gpt-5.2-chat``). Reuses an unlinkable key until it's used up, then
  re-mints from a local ticket pool (``OA_TICKET_FILE``, which must be set).
  The relay ``destination`` defaults to ``openrouter`` (override with
  ``OA_DESTINATION``) and the endpoint with ``OA_BASE_URL``.
- ``tinfoil/<model>`` -> Tinfoil confidential inference served from attested
  hardware enclaves (e.g. ``tinfoil/llama3-3-70b``). Requires
  ``TINFOIL_API_KEY``; the enclave is auto-selected and verified from the key.
- anything else -> LiteLLM (OpenAI, Anthropic, Gemini, ...).

Two entry points share this routing:

- :func:`chat_completion` — the low-level API. Takes LiteLLM-shaped messages and
  returns ``(LiteLLMMessage, LLMCallMetrics)`` regardless of backend.
- :func:`prompt_to_text` — a convenience wrapper for the common
  system-prompt + user-prompt (+ optional images) case that returns the reply
  text as a plain string.
- :func:`prompt_to_text_with_metrics` — the same convenience wrapper, returning
  ``(reply_text, LLMCallMetrics)`` for observability-aware callers.
"""

from __future__ import annotations

import base64
import os
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
    get_litellm_completion,
)
from external_api.lm_studio_api import (
    ImageContent as LMSImageContent,
)
from external_api.lm_studio_api import (
    LMStudioMessage,
    get_lm_studio_completion,
)
from external_api.lm_studio_api import (
    TextContent as LMSTextContent,
)
from external_api.oa_api import (
    ImageURL as OAImageURL,
)
from external_api.oa_api import (
    ImageURLContent as OAImageURLContent,
)
from external_api.oa_api import (
    OAMessage,
    get_oa_completion,
)
from external_api.oa_api import (
    TextContent as OATextContent,
)
from external_api.tinfoil_api import (
    ImageURL as TinfoilImageURL,
)
from external_api.tinfoil_api import (
    ImageURLContent as TinfoilImageURLContent,
)
from external_api.tinfoil_api import (
    TextContent as TinfoilTextContent,
)
from external_api.tinfoil_api import (
    TinfoilMessage,
    get_tinfoil_completion,
)
from external_api.types import LLMCallMetrics, TokenUsage

LM_STUDIO_PREFIX = "lm_studio/"
OA_PREFIX = "oa/"
TINFOIL_PREFIX = "tinfoil/"


def _provider_for_model(model: str) -> str:
    if model.startswith(LM_STUDIO_PREFIX):
        return "lm_studio"
    if model.startswith(OA_PREFIX):
        return "oa"
    if model.startswith(TINFOIL_PREFIX):
        return "tinfoil"
    return "litellm"


def _infer_modality(messages: Sequence[LiteLLMMessage | dict]) -> Literal["llm", "vlm"]:
    for m in messages:
        content = m.content if isinstance(m, LiteLLMMessage) else m.get("content")
        if content is None:
            continue
        for kind, _ in _iter_content_blocks(content):
            if kind == "image":
                return "vlm"
    return "llm"


def _build_call_metrics(
    *,
    model: str,
    provider: str,
    operation: str | None,
    modality: Literal["llm", "vlm"],
    usage: TokenUsage,
    started_at: float,
    ended_at: float,
    elapsed_s: float,
    success: bool = True,
    error: str | None = None,
) -> LLMCallMetrics:
    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
    completion_tokens = int(usage.get("completion_tokens", 0) or 0)
    cache_creation_input_tokens = int(
        usage.get("cache_creation_input_tokens", 0) or 0
    )
    cache_read_input_tokens = int(usage.get("cache_read_input_tokens", 0) or 0)
    return LLMCallMetrics(
        call_id=uuid.uuid4().hex,
        operation=operation,
        model=model,
        provider=provider,
        modality=modality,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_creation_input_tokens=cache_creation_input_tokens,
        cache_read_input_tokens=cache_read_input_tokens,
        input_tokens=prompt_tokens,
        output_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        duration_ms=round(elapsed_s * 1000, 3),
        started_at=started_at,
        ended_at=ended_at,
        success=success,
        error=error,
    )


def _iter_content_blocks(content: Any) -> list[tuple[str, str]]:
    """Normalize a message ``content`` field into ``(kind, value)`` pairs.

    Accepts a bare string (treated as a single text block), a list of
    pydantic ``TextContent`` / ``ImageURLContent`` instances, or the dict shape
    LiteLLM consumes (``{"type": "text", ...}`` / ``{"type": "image_url", ...}``).
    """
    if isinstance(content, str):
        return [("text", content)]

    blocks: list[tuple[str, str]] = []
    for b in content:
        if isinstance(b, TextContent):
            blocks.append(("text", b.text))
        elif isinstance(b, ImageURLContent):
            blocks.append(("image", b.image_url.url))
        elif isinstance(b, dict):
            kind = b.get("type")
            if kind == "text":
                blocks.append(("text", b.get("text", "")))
            elif kind == "image_url":
                url = (b.get("image_url") or {}).get("url", "")
                if url:
                    blocks.append(("image", url))
        elif hasattr(b, "text"):
            blocks.append(("text", b.text))
        elif hasattr(b, "image_url"):
            blocks.append(("image", b.image_url.url))
    return blocks


def _to_lm_studio_messages(
    messages: Sequence[LiteLLMMessage | dict],
) -> list[LMStudioMessage]:
    out: list[LMStudioMessage] = []
    for m in messages:
        if isinstance(m, LiteLLMMessage):
            role = m.role
            content: Any = m.content
        else:
            role = m["role"]
            content = m["content"]

        if role not in ("system", "user", "assistant"):
            raise ValueError(f"Unsupported role for LM Studio: {role}")

        blocks: list[LMSTextContent | LMSImageContent] = []
        for kind, value in _iter_content_blocks(content):
            if kind == "text":
                if value:
                    blocks.append(LMSTextContent(text=value))
            else:
                blocks.append(LMSImageContent(source=value))

        if not blocks:
            continue
        out.append(LMStudioMessage(role=role, content=blocks))  # type: ignore[arg-type]
    return out


def _lms_to_litellm(output: LMStudioMessage) -> LiteLLMMessage:
    """Re-shape an LM Studio assistant reply as a ``LiteLLMMessage``.

    Lets call sites assume ``response.content[0].text`` regardless of backend.
    """
    converted: list[TextContent | ImageURLContent] = []
    for block in output.content:
        if isinstance(block, LMSTextContent):
            converted.append(TextContent(text=block.text))
    if not converted:
        converted.append(TextContent(text=""))
    return LiteLLMMessage(role=output.role, content=converted)


def _to_oa_messages(
    messages: Sequence[LiteLLMMessage | dict],
) -> list[OAMessage]:
    out: list[OAMessage] = []
    for m in messages:
        if isinstance(m, LiteLLMMessage):
            role = m.role
            content: Any = m.content
        else:
            role = m["role"]
            content = m["content"]

        if role not in ("system", "user", "assistant"):
            raise ValueError(f"Unsupported role for OA: {role}")

        blocks: list[OATextContent | OAImageURLContent] = []
        for kind, value in _iter_content_blocks(content):
            if kind == "text":
                if value:
                    blocks.append(OATextContent(text=value))
            else:
                blocks.append(OAImageURLContent(image_url=OAImageURL(url=value)))

        if not blocks:
            continue
        out.append(OAMessage(role=role, content=blocks))  # type: ignore[arg-type]
    return out


def _oa_to_litellm(output: OAMessage) -> LiteLLMMessage:
    """Re-shape an OA assistant reply as a ``LiteLLMMessage``.

    Lets call sites assume ``response.content[0].text`` regardless of backend.
    """
    converted: list[TextContent | ImageURLContent] = []
    for block in output.content:
        if isinstance(block, OATextContent):
            converted.append(TextContent(text=block.text))
    if not converted:
        converted.append(TextContent(text=""))
    return LiteLLMMessage(role=output.role, content=converted)


def _to_tinfoil_messages(
    messages: Sequence[LiteLLMMessage | dict],
) -> list[TinfoilMessage]:
    out: list[TinfoilMessage] = []
    for m in messages:
        if isinstance(m, LiteLLMMessage):
            role = m.role
            content: Any = m.content
        else:
            role = m["role"]
            content = m["content"]

        if role not in ("system", "user", "assistant"):
            raise ValueError(f"Unsupported role for Tinfoil: {role}")

        blocks: list[TinfoilTextContent | TinfoilImageURLContent] = []
        for kind, value in _iter_content_blocks(content):
            if kind == "text":
                if value:
                    blocks.append(TinfoilTextContent(text=value))
            else:
                blocks.append(
                    TinfoilImageURLContent(image_url=TinfoilImageURL(url=value))
                )

        if not blocks:
            continue
        out.append(TinfoilMessage(role=role, content=blocks))  # type: ignore[arg-type]
    return out


def _tinfoil_to_litellm(output: TinfoilMessage) -> LiteLLMMessage:
    """Re-shape a Tinfoil assistant reply as a ``LiteLLMMessage``.

    Lets call sites assume ``response.content[0].text`` regardless of backend.
    """
    converted: list[TextContent | ImageURLContent] = []
    for block in output.content:
        if isinstance(block, TinfoilTextContent):
            converted.append(TextContent(text=block.text))
    if not converted:
        converted.append(TextContent(text=""))
    return LiteLLMMessage(role=output.role, content=converted)


def _chat_completion_provider(
    messages: Sequence[LiteLLMMessage | dict],
    model: str,
    temperature: float = 1.0,
    max_tokens: int | None = None,
    top_p: float | None = None,
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "default"]
    | None = None,
) -> tuple[LiteLLMMessage, TokenUsage]:
    """Run a completion, dispatching by ``model`` prefix (LM Studio, OA,
    Tinfoil, LiteLLM)."""
    if model.startswith(LM_STUDIO_PREFIX):
        lms_model = model[len(LM_STUDIO_PREFIX) :]
        host = os.environ.get("LM_STUDIO_HOST", "localhost:1234")
        output, usage = get_lm_studio_completion(
            _to_lm_studio_messages(messages),
            model=lms_model,
            host=host,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
        )
        return _lms_to_litellm(output), usage

    if model.startswith(OA_PREFIX):
        oa_model = model[len(OA_PREFIX) :]
        # Only forward the endpoint / destination overrides when their env vars
        # are set so OA's own defaults apply otherwise.
        oa_kwargs: dict = {}
        base_url = os.environ.get("OA_BASE_URL")
        if base_url:
            oa_kwargs["base_url"] = base_url
        destination = os.environ.get("OA_DESTINATION")
        if destination:
            oa_kwargs["destination"] = destination
        output, usage = get_oa_completion(
            _to_oa_messages(messages),
            model=oa_model,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            **oa_kwargs,
        )
        return _oa_to_litellm(output), usage

    if model.startswith(TINFOIL_PREFIX):
        tinfoil_model = model[len(TINFOIL_PREFIX) :]
        output, usage = get_tinfoil_completion(
            _to_tinfoil_messages(messages),
            model=tinfoil_model,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
        )
        return _tinfoil_to_litellm(output), usage

    return get_litellm_completion(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=top_p,
        reasoning_effort=reasoning_effort,
    )


def chat_completion(
    messages: Sequence[LiteLLMMessage | dict],
    model: str,
    temperature: float = 1.0,
    max_tokens: int | None = None,
    top_p: float | None = None,
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "default"]
    | None = None,
    operation: str | None = None,
) -> tuple[LiteLLMMessage, LLMCallMetrics]:
    """Run a completion and return a normalized response plus call metrics."""
    provider = _provider_for_model(model)
    modality = _infer_modality(messages)
    started_at = time.time()
    started_perf = time.perf_counter()
    try:
        output, usage = _chat_completion_provider(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            reasoning_effort=reasoning_effort,
        )
    except Exception:
        # Preserve existing failure semantics. Callers only receive metrics for
        # completed calls; failed-call logging can be added where exceptions are
        # handled without changing this public return contract.
        raise

    ended_perf = time.perf_counter()
    ended_at = time.time()
    metrics = _build_call_metrics(
        model=model,
        provider=provider,
        operation=operation,
        modality=modality,
        usage=usage,
        started_at=started_at,
        ended_at=ended_at,
        elapsed_s=ended_perf - started_perf,
    )
    return output, metrics


def _build_prompt_messages(
    system_prompt: str,
    user_prompt: str,
    image_paths: list[str] | None = None,
) -> list[LiteLLMMessage]:
    user_content: list[TextContent | ImageURLContent] = []

    for path in image_paths or []:
        if not os.path.exists(path):
            raise FileNotFoundError(f"Could not find image file: {path}")
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        suffix = Path(path).suffix.lstrip(".").lower()
        mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix or 'png'}"
        user_content.append(
            ImageURLContent(image_url=ImageURL(url=f"data:{mime};base64,{b64}"))
        )

    user_content.append(TextContent(text=user_prompt))

    messages = [
        LiteLLMMessage(role="system", content=[TextContent(text=system_prompt)]),
        LiteLLMMessage(role="user", content=user_content),
    ]
    return messages


def _response_text(response: LiteLLMMessage) -> str:
    return response.content[0].text  # type: ignore


def prompt_to_text_with_metrics(
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_paths: list[str] | None = None,
    operation: str | None = None,
) -> tuple[str, LLMCallMetrics]:
    """Convenience wrapper that also returns normalized call metrics."""
    messages = _build_prompt_messages(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        image_paths=image_paths,
    )
    response, metrics = chat_completion(
        messages,
        model=model,
        max_tokens=8192,
        operation=operation,
    )
    return _response_text(response), metrics


def prompt_to_text(
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_paths: list[str] | None = None,
) -> str:
    """Convenience wrapper: system + user prompt (+ optional images) -> reply text.

    Builds LiteLLM-shaped messages and dispatches through :func:`chat_completion`,
    so every backend (LM Studio, OA, Tinfoil, LiteLLM) is available.
    """
    response, _ = prompt_to_text_with_metrics(
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        image_paths=image_paths,
    )
    return response
