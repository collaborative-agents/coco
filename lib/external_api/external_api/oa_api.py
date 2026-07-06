"""Synchronous wrapper around The Open Anonymity Project (``oa-sdk``).

OA provides *unlinkable inference*: requests are relayed so the upstream
provider (e.g. OpenRouter) cannot link a prompt back to the caller's identity —
useful when the payload is sensitive, as with screen-observation prompts.

This wrapper talks to OA through its ``oa`` simple API
(https://github.com/OpenAnonymity/oa-sdk).

Keys and unlinkability
----------------------
A minted key is spent from a ticket pool and is *time-limited* (it carries an
``expires_at_unix`` but no per-request budget). Minting a fresh key per request
maximizes unlinkability but burns one ticket every call, which is too expensive
for high-frequency callers like screen sensing.

So this wrapper **reuses a single key until it is used up** — i.e. until it
expires or the relay rejects it (a spent-ticket / auth / quota error) — then
mints the next one from the ticket pool.
"""

import logging
import os
import threading
import time
from collections.abc import Sequence
from typing import Any, Literal

from external_api.types import TokenUsage
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# OpenRouter is OA's default (and best-supported) relay destination.
DEFAULT_DESTINATION = "openrouter"

# Re-mint slightly before the stated expiry so a key doesn't lapse mid-request.
_EXPIRY_MARGIN_SECONDS = 30
# HTTP statuses that mean "this key won't work anymore" (spent / auth / quota).
_KEY_REJECTED_STATUS = frozenset({401, 402, 403, 429})
# Substrings in an error message that also signal a used-up / invalid key.
_KEY_REJECTED_MARKERS = (
    "spent",
    "used",
    "expired",
    "exhaust",
    "deplet",
    "insufficient",
    "unauthor",
    "quota",
)

# Process-local cache of the current unlinkable key, guarded for concurrent use
# (sensing / tutor may issue completions from multiple threads).
_key_lock = threading.Lock()
_cached_lease: dict | None = None  # {"key": str, "expires_at_unix": int | None}


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


class OAMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock]


def reset_key_cache() -> None:
    """Drop the cached key (used by tests; also forces a re-mint on next call)."""
    global _cached_lease
    with _key_lock:
        _cached_lease = None


def _lease_valid(lease: dict | None) -> bool:
    if not lease or not lease.get("key"):
        return False
    expires = lease.get("expires_at_unix")
    if expires is None:
        # No expiry info — treat as valid until the relay rejects it.
        return True
    return time.time() < (expires - _EXPIRY_MARGIN_SECONDS)


def _mint_lease(oa, ticket_file: str | None) -> dict:
    """Spend one ticket to mint a new unlinkable key lease."""
    resolved_ticket_file = ticket_file or os.getenv("OA_TICKET_FILE")
    if not resolved_ticket_file:
        raise ValueError(
            "No OA ticket file configured. Pass ticket_file=... or set the "
            "OA_TICKET_FILE environment variable to a ticket pool with unspent "
            "tickets (redeem some with oa.add_tickets('TICKET_CODE'))."
        )
    # save=True writes the spent ticket back as archived so the next mint picks
    # a fresh ticket instead of re-selecting (and re-failing on) this one. It
    # only records ticket bookkeeping — the minted key itself is never persisted.
    lease = oa.request_unlinkable_key(
        ticket_file=resolved_ticket_file, ticket_count=1, save=True
    )
    key = lease.get("key") if isinstance(lease, dict) else None
    if not key:
        raise ValueError(
            "request_unlinkable_key did not return a key; check that "
            f"{resolved_ticket_file!r} exists and has unspent tickets "
            "(redeem more with oa.add_tickets('TICKET_CODE'))."
        )
    return {"key": key, "expires_at_unix": lease.get("expires_at_unix")}


def _get_cached_key(oa, ticket_file: str | None) -> str:
    """Return the cached key, minting (and caching) a fresh one if it's used up."""
    global _cached_lease
    with _key_lock:
        if not _lease_valid(_cached_lease):
            _cached_lease = _mint_lease(oa, ticket_file)
        assert _cached_lease is not None  # _lease_valid(None) is False -> minted above
        return _cached_lease["key"]


def _refresh_cached_key(oa, ticket_file: str | None, used_key: str) -> str:
    """Replace a rejected key with a fresh one, unless another thread already did.

    Comparing against ``used_key`` avoids a mint stampede when several concurrent
    requests all fail on the same expired key — only the first re-mints.
    """
    global _cached_lease
    with _key_lock:
        if _cached_lease and _cached_lease["key"] != used_key:
            return _cached_lease["key"]
        _cached_lease = _mint_lease(oa, ticket_file)
        return _cached_lease["key"]


def _is_key_rejected_error(exc: Exception) -> bool:
    """Heuristic: does this error mean the key is used up / no longer valid?"""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status in _KEY_REJECTED_STATUS:
        return True
    if type(exc).__name__ in ("TicketUsedError", "InsufficientTicketsError"):
        return True
    message = str(exc).lower()
    return any(marker in message for marker in _KEY_REJECTED_MARKERS)


def _import_oa():
    """Import the optional ``oa`` SDK, with an actionable error if it's missing."""
    try:
        import oa  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise ImportError(
            "The 'oa-sdk-py' package is required for oa inference. Install it with "
            '`uv pip install "oa-sdk-py @ git+https://github.com/OpenAnonymity/oa-sdk.git"`.'
        ) from exc
    return oa


def _to_openai_messages(messages: Sequence[OAMessage | dict]) -> list[dict]:
    """Render messages as OpenAI-style dicts for the relayed request payload."""
    out: list[dict] = []
    for m in messages:
        dumped = m.model_dump(by_alias=True) if isinstance(m, OAMessage) else dict(m)
        out.append(dumped)
    return out


def _flatten_user_text(messages: Sequence[OAMessage | dict]) -> str:
    """Best-effort plain-text prompt (the OA ``prompt`` field is required).

    ``extra["messages"]`` overrides this for the actual request, but a sensible
    non-empty value keeps the SDK happy and aids any logging on OA's side.
    """
    parts: list[str] = []
    for m in messages:
        role = m.role if isinstance(m, OAMessage) else m.get("role")
        if role != "user":
            continue
        content = m.content if isinstance(m, OAMessage) else m.get("content")
        if isinstance(content, str):
            parts.append(content)
            continue
        for block in content or []:
            if isinstance(block, TextContent):
                parts.append(block.text)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
    return "\n".join(p for p in parts if p) or "(see attached content)"


def _extract_usage(raw: Any) -> TokenUsage:
    """Pull token counts out of the upstream response echoed in ``raw``.

    OA does not expose usage as a top-level field, but relayed OpenAI-compatible
    responses carry a ``usage`` object; fall back to zeros when absent so the
    TokenUsage shape stays consistent with the other providers.
    """
    usage = raw.get("usage") if isinstance(raw, dict) else None
    if not isinstance(usage, dict):
        return TokenUsage(
            prompt_tokens=0,
            completion_tokens=0,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
        )
    return TokenUsage(
        prompt_tokens=usage.get("prompt_tokens", 0) or 0,
        completion_tokens=usage.get("completion_tokens", 0) or 0,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )


def get_oa_completion(
    messages: Sequence[OAMessage | dict],
    model: str,
    key: str | None = None,
    ticket_file: str | None = None,
    destination: str = DEFAULT_DESTINATION,
    base_url: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
) -> tuple[OAMessage, TokenUsage]:
    """Get a completion via OA unlinkable inference.

    ``model`` is the OA/OpenRouter model id (e.g. ``openai/gpt-5.2-chat``).
    A cached unlinkable key is reused until it's used up (expired or rejected),
    then re-minted from ``ticket_file`` (falling back to ``OA_TICKET_FILE`` /
    ``oa-chat-tickets.json``); pass an explicit ``key`` to bypass the cache.
    ``destination`` selects the relay backend (default ``openrouter``). Sampling
    parameters left as ``None`` defer to the model's defaults.
    """
    oa = _import_oa()

    # Carry the real (multimodal, multi-role) request through ``extra`` since the
    # simple API's ``prompt`` is a single string; ``extra`` is merged wholesale
    # into the payload and overrides the auto-built ``messages``.
    extra: dict[str, Any] = {"messages": _to_openai_messages(messages)}
    if top_p is not None:
        extra["top_p"] = top_p

    request_key = key or _get_cached_key(oa, ticket_file)
    kwargs: dict[str, Any] = {
        "key": request_key,
        "model": model,
        "prompt": _flatten_user_text(messages),
        "destination": destination,
        "extra": extra,
    }
    if base_url is not None:
        kwargs["base_url"] = base_url
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_output_tokens"] = max_tokens

    try:
        response = oa.chat_completion(**kwargs)
    except Exception as exc:
        # An explicit (caller-managed) key is never silently re-minted; and only
        # a "key used up" style error triggers one retry with a fresh key.
        if key is not None or not _is_key_rejected_error(exc):
            raise
        kwargs["key"] = _refresh_cached_key(oa, ticket_file, request_key)
        response = oa.chat_completion(**kwargs)

    content = response.get("output_text", "") if isinstance(response, dict) else ""
    output = OAMessage(role="assistant", content=[TextContent(text=content or "")])
    usage = _extract_usage(response.get("raw") if isinstance(response, dict) else None)
    return output, usage
