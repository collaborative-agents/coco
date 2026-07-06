"""Tests for the Open Anonymity (OA) unlinkable-inference wrapper.

```
uv run pytest lib/external_api/external_api/oa_api_test.py -v
```

Two layers:

* **Mock tests** run everywhere — they stub out the ``oa`` SDK and assert how
  ``get_oa_completion`` builds the relayed request (crucially, that text and
  image content survive via ``extra["messages"]``), that a key is reused until
  it's used up and then re-minted, and how the reply is parsed.
* **Live tests** hit the real OA relay and are skipped unless the ``oa-sdk-py``
  package is installed *and* a ticket file with unspent tickets is available.
"""

import base64
import os
import struct
import zlib

import pytest
from external_api import oa_api
from external_api.oa_api import (
    ImageURL,
    ImageURLContent,
    OAMessage,
    TextContent,
    get_oa_completion,
)

# Load the repo-root .env so a user's OA_TICKET_FILE (and any OA_* config) is
# visible to the live tests. uv/pytest do not auto-load .env. Best-effort:
# missing python-dotenv or .env just leaves the environment untouched.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - dotenv is a dev convenience
    pass

# Editable to point at a different OA/OpenRouter model. The vision model must be
# multimodal for the text+image live test to succeed.
MODEL = "openai/gpt-5.2-chat"
VISION_MODEL = "openai/gpt-5.2-chat"
IMAGE_URL = "https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"


def _response_text(message: OAMessage) -> str:
    return "".join(
        block.text for block in message.content if isinstance(block, TextContent)
    )


def _solid_png_data_uri(width: int = 16, height: int = 16, rgb=(200, 60, 60)) -> str:
    """Build a small solid-color PNG as a base64 data URI (stdlib only).

    Live image tests use an embedded data URI, not a remote URL: OpenRouter
    fetches remote image URLs server-side (flaky / times out), whereas real
    sensing sends local screenshots as data URIs — this exercises that path.
    """

    def _chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = (b"\x00" + bytes(rgb) * width) * height  # filter byte 0 per scanline
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw))
        + _chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode()


# --------------------------------------------------------------------------- #
# Mock layer: stub the ``oa`` SDK and inspect the request we hand it.
# --------------------------------------------------------------------------- #


class _FakeHTTPError(Exception):
    """Mimics oa_sdk.errors.OAHTTPError (carries a status_code)."""

    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}")


class _FakeOA:
    """Stub SDK: records key-minting + chat calls, returns canned values.

    Each mint returns a distinct key (``key-1``, ``key-2``, ...) so tests can
    tell reuse from re-mint. ``mint_result`` overrides that with a verbatim
    lease; ``expires_at_unix`` stamps every minted lease; ``chat_errors`` is a
    queue of exceptions (or ``None``) raised on successive chat calls.
    """

    def __init__(
        self,
        response: dict,
        *,
        mint_result: dict | None = None,
        expires_at_unix: int | None = None,
        chat_errors: list | None = None,
    ):
        self._response = response
        self._mint_result = mint_result
        self._expires = expires_at_unix
        self._mint_count = 0
        self._chat_errors = list(chat_errors or [])
        self.key_requests: list[dict] = []
        self.calls: list[dict] = []

    def request_unlinkable_key(self, **kwargs):
        self.key_requests.append(kwargs)
        self._mint_count += 1
        if self._mint_result is not None:
            return self._mint_result
        return {"key": f"key-{self._mint_count}", "expires_at_unix": self._expires}

    def chat_completion(self, **kwargs):
        self.calls.append(kwargs)
        if self._chat_errors:
            err = self._chat_errors.pop(0)
            if err is not None:
                raise err
        return self._response


@pytest.fixture(autouse=True)
def clear_key_cache(monkeypatch):
    """Isolate the process-local key cache and give tests a ticket file.

    ``_cached_lease`` is a module global; without this reset a valid key leaks
    between tests and the mint-expecting cases would never re-mint.

    Preserve a real ``OA_TICKET_FILE`` (e.g. from .env) so the live tests can
    find it; only fall back to a dummy when none is set, so mock tests that mint
    still clear the "ticket file configured" guard.
    """
    monkeypatch.setenv(
        "OA_TICKET_FILE", os.getenv("OA_TICKET_FILE") or "test-tickets.json"
    )
    oa_api.reset_key_cache()
    yield
    oa_api.reset_key_cache()


@pytest.fixture
def fake_oa(monkeypatch):
    fake = _FakeOA(
        {
            "response_id": "resp_123",
            "output_text": "Paris",
            "raw": {"usage": {"prompt_tokens": 12, "completion_tokens": 3}},
        }
    )
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    return fake


def test_text_only_builds_payload_and_parses(fake_oa):
    """A text-only request forwards messages via ``extra`` and parses the reply."""
    messages = [
        OAMessage(role="system", content=[TextContent(text="You are terse.")]),
        OAMessage(
            role="user", content=[TextContent(text="What's the capital of France?")]
        ),
    ]

    output, usage = get_oa_completion(
        messages, model=MODEL, key="explicit-key", temperature=0.2, max_tokens=128
    )

    # Reply parsing.
    assert isinstance(output, OAMessage)
    assert output.role == "assistant"
    assert _response_text(output) == "Paris"
    assert usage["prompt_tokens"] == 12
    assert usage["completion_tokens"] == 3

    # Request construction.
    (call,) = fake_oa.calls
    assert call["key"] == "explicit-key"
    assert call["model"] == MODEL
    assert call["destination"] == "openrouter"
    assert call["temperature"] == 0.2
    assert call["max_output_tokens"] == 128
    # The bare prompt carries the user text; the real (multi-role) request rides
    # in extra["messages"].
    assert call["prompt"] == "What's the capital of France?"
    fwd = call["extra"]["messages"]
    assert [m["role"] for m in fwd] == ["system", "user"]
    assert fwd[1]["content"][0] == {
        "type": "text",
        "text": "What's the capital of France?",
    }


def test_text_and_image_preserves_image_block(fake_oa):
    """An image block survives into the relayed ``extra["messages"]`` payload."""
    messages = [
        OAMessage(
            role="user",
            content=[
                TextContent(text="Describe this image."),
                ImageURLContent(image_url=ImageURL(url=IMAGE_URL)),
            ],
        )
    ]

    get_oa_completion(messages, model=VISION_MODEL, key="k")

    (call,) = fake_oa.calls
    blocks = call["extra"]["messages"][0]["content"]
    kinds = [b["type"] for b in blocks]
    assert kinds == ["text", "image_url"]
    # image_url is serialized OpenAI-style so a vision model can consume it.
    assert blocks[1]["image_url"]["url"] == IMAGE_URL
    # Prompt flattens to the text part only.
    assert call["prompt"] == "Describe this image."


def test_dict_messages_pass_through(fake_oa):
    """Raw OpenAI-style dict messages are forwarded unchanged."""
    messages = [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]

    get_oa_completion(messages, model=MODEL, key="k")

    (call,) = fake_oa.calls
    assert call["extra"]["messages"] == messages


def test_reuses_key_across_requests(fake_oa):
    """A valid cached key is reused instead of minting one per request."""
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    get_oa_completion(messages, model=MODEL)
    get_oa_completion(messages, model=MODEL)
    get_oa_completion(messages, model=MODEL)

    # Only one ticket spent for three requests; same key reused throughout.
    assert len(fake_oa.key_requests) == 1
    assert [c["key"] for c in fake_oa.calls] == ["key-1", "key-1", "key-1"]


def test_remints_when_key_expired(monkeypatch):
    """An expired cached key is replaced on the next request."""
    # expires_at_unix in the past -> lease is never valid, so every call re-mints.
    fake = _FakeOA({"output_text": "ok", "raw": {}}, expires_at_unix=1)
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    get_oa_completion(messages, model=MODEL)
    get_oa_completion(messages, model=MODEL)

    assert len(fake.key_requests) == 2
    assert [c["key"] for c in fake.calls] == ["key-1", "key-2"]


def test_remints_and_retries_on_rejection(monkeypatch):
    """A used-up key (rejected by the relay) is re-minted and the call retried."""
    fake = _FakeOA(
        {"output_text": "ok", "raw": {}},
        chat_errors=[_FakeHTTPError(401), None],  # first call rejected, then ok
    )
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    output, _ = get_oa_completion(messages, model=MODEL)

    # Initial mint + one re-mint after the rejection; retry used the fresh key.
    assert len(fake.key_requests) == 2
    assert [c["key"] for c in fake.calls] == ["key-1", "key-2"]
    assert _response_text(output) == "ok"


def test_non_rejection_error_propagates(monkeypatch):
    """A non-key error is raised as-is, without spending another ticket."""
    fake = _FakeOA({"output_text": "x", "raw": {}}, chat_errors=[RuntimeError("boom")])
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    with pytest.raises(RuntimeError, match="boom"):
        get_oa_completion(messages, model=MODEL)
    assert len(fake.key_requests) == 1  # no re-mint


def test_explicit_key_bypasses_cache(fake_oa):
    """Passing key= skips the cache/mint entirely and is never re-minted."""
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    get_oa_completion(messages, model=MODEL, key="caller-managed")

    assert fake_oa.key_requests == []
    assert fake_oa.calls[0]["key"] == "caller-managed"


def test_explicit_key_not_reminted_on_rejection(monkeypatch):
    """An explicit key is caller-managed: a rejection propagates, no re-mint."""
    fake = _FakeOA({"output_text": "x", "raw": {}}, chat_errors=[_FakeHTTPError(401)])
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    with pytest.raises(_FakeHTTPError):
        get_oa_completion(messages, model=MODEL, key="caller-managed")
    assert fake.key_requests == []


def test_ticket_file_resolution(fake_oa, monkeypatch):
    """ticket_file arg wins; otherwise OA_TICKET_FILE; neither set is an error."""
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    # Explicit arg. (Cache is cleared before each mint so ticket_file is re-read.)
    get_oa_completion(messages, model=MODEL, ticket_file="custom.json")
    assert fake_oa.key_requests[-1]["ticket_file"] == "custom.json"

    # Falls back to OA_TICKET_FILE.
    oa_api.reset_key_cache()
    monkeypatch.setenv("OA_TICKET_FILE", "env-tickets.json")
    get_oa_completion(messages, model=MODEL)
    assert fake_oa.key_requests[-1]["ticket_file"] == "env-tickets.json"

    # Neither set -> raise, rather than silently using a default ticket file.
    oa_api.reset_key_cache()
    monkeypatch.delenv("OA_TICKET_FILE", raising=False)
    with pytest.raises(ValueError, match="No OA ticket file configured"):
        get_oa_completion(messages, model=MODEL)


def test_no_ticket_key_raises(monkeypatch):
    """A clear error is raised when minting yields no usable key."""
    fake = _FakeOA({"output_text": "x", "raw": {}}, mint_result={"tickets_consumed": 0})
    monkeypatch.setattr(oa_api, "_import_oa", lambda: fake)
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    with pytest.raises(ValueError, match="did not return a key"):
        get_oa_completion(messages, model=MODEL)


def test_missing_usage_defaults_to_zero(fake_oa):
    """When the relayed response has no usage block, counts default to zero."""
    fake_oa._response = {"output_text": "ok", "raw": {}}
    messages = [OAMessage(role="user", content=[TextContent(text="hi")])]

    _, usage = get_oa_completion(messages, model=MODEL, key="k")

    assert usage["prompt_tokens"] == 0
    assert usage["completion_tokens"] == 0


# --------------------------------------------------------------------------- #
# Live layer: real OA relay. Skipped without the SDK + a ticket file.
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def live_key():
    """Mint ONE unlinkable key for the whole live module (spends one ticket).

    Both live tests share it (passed as an explicit ``key=``) so a full run
    costs a single ticket instead of one per test. Module-scoped so the
    function-scoped cache-reset fixture can't force a re-mint between them.
    """
    try:
        import oa  # type: ignore
    except ImportError:
        pytest.skip("oa-sdk-py not installed")
    ticket_file = os.getenv("OA_TICKET_FILE")
    if not ticket_file:
        pytest.skip("OA_TICKET_FILE not set (put it in .env or export it)")
    if not os.path.exists(ticket_file):
        pytest.skip(f"OA ticket file {ticket_file!r} not found (redeem tickets first)")
    # Reuse the adapter's minting path (spends + archives one ticket via save=True).
    try:
        lease = oa_api._mint_lease(oa, ticket_file)
    except Exception as exc:  # e.g. TicketUsedError when the pool is depleted
        pytest.skip(f"could not mint an OA key: {exc}")
    return lease["key"]


def test_live_text_only(live_key):
    """Real text-only round-trip through the OA relay (shared key)."""
    messages = [
        OAMessage(
            role="user", content=[TextContent(text="What's the capital of France?")]
        )
    ]

    output, _ = get_oa_completion(
        messages,
        model=MODEL,
        key=live_key,
        temperature=0.2,
        max_tokens=128,
    )

    assert output.role == "assistant"
    assert "paris" in _response_text(output).lower()


def test_live_text_and_image(live_key):
    """Real text+image round-trip (requires a vision-capable model, shared key).

    Uses an embedded base64 data URI (not a remote URL) so the provider doesn't
    have to fetch the image server-side — mirrors how sensing sends screenshots.
    """
    messages = [
        OAMessage(
            role="user",
            content=[
                TextContent(text="What color is this image? Answer in one word."),
                ImageURLContent(image_url=ImageURL(url=_solid_png_data_uri())),
            ],
        )
    ]

    output, _ = get_oa_completion(
        messages, model=VISION_MODEL, key=live_key, max_tokens=256
    )

    assert len(_response_text(output)) > 0
