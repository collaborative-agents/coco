"""Bounds and retry policy for background personalization LLM calls."""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")

TRANSIENT_HTTP_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
MAX_OBSERVER_INPUT_CHARS = 24_000
MAX_MEMORY_CHARS = 16_000
MAX_ROLE_PROMPT_CHARS = 36_000
MAX_REVISION_PROMPT_CHARS = 32_000
MAX_PERSONALIZATION_IMAGE_BYTES = 2 * 1024 * 1024


def bounded_text(value: Any, max_chars: int) -> str:
    """Keep useful context from both ends while enforcing a hard character cap."""
    text = str(value or "")
    if max_chars < 64:
        raise ValueError("max_chars must be at least 64")
    if len(text) <= max_chars:
        return text
    marker = "\n...[personalization input truncated]...\n"
    available = max_chars - len(marker)
    head = round(available * 0.65)
    return f"{text[:head]}{marker}{text[-(available - head) :]}"


def personalization_completion_kwargs(model: str) -> dict[str, Any]:
    """Match the low-latency model settings used by the live observer."""
    hosted_model = model.removeprefix("hosted_vllm/").lower()
    kwargs: dict[str, Any] = {}
    if "qwen" in hosted_model:
        kwargs["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
    if hosted_model.startswith("thinkingmachines/inkling"):
        kwargs["reasoning_effort"] = "none"
    return kwargs


def _exception_chain(error: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and current not in chain and len(chain) < 8:
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def transient_llm_error(error: BaseException) -> bool:
    """Recognize retryable gateway, throttling, connection, and timeout errors."""
    chain = _exception_chain(error)
    for item in chain:
        response = getattr(item, "response", None)
        status = getattr(item, "status_code", None) or getattr(
            response, "status_code", None
        )
        try:
            if int(status) in TRANSIENT_HTTP_STATUS_CODES:
                return True
        except (TypeError, ValueError):
            pass
        name = type(item).__name__.lower()
        if any(
            marker in name
            for marker in (
                "timeout",
                "connectionerror",
                "connecterror",
                "remoteprotocolerror",
                "ratelimiterror",
                "serviceunavailable",
            )
        ):
            return True

    message = " ".join(str(item) for item in chain).lower()
    return any(
        marker in message
        for marker in (
            "gateway time-out",
            "gateway timeout",
            "status code: 504",
            "status_code=504",
            "service unavailable",
            "connection reset",
            "connection refused",
            "timed out",
            "timeout",
            "rate limit",
            "too many requests",
        )
    )


def call_with_transient_retries(
    call: Callable[[], T],
    *,
    operation: str,
    max_attempts: int = 3,
    base_delay_s: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Retry transient provider failures without hiding permanent errors."""
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    for attempt in range(1, max_attempts + 1):
        try:
            return call()
        except Exception as error:
            if attempt >= max_attempts or not transient_llm_error(error):
                raise
            delay = base_delay_s * (2 ** (attempt - 1))
            print(
                f"{operation}: transient model request failure "
                f"({type(error).__name__}); retrying attempt {attempt + 1}/"
                f"{max_attempts} in {delay:g}s",
                file=sys.stderr,
            )
            sleep(delay)
    raise AssertionError("retry loop exited without returning or raising")
