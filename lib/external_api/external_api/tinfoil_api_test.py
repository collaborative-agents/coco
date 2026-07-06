"""Tests for the Tinfoil confidential-inference wrapper.

```
uv run pytest lib/external_api/external_api/tinfoil_api_test.py -v
```

Two layers:

* **Mock tests** run everywhere — they stub out the ``tinfoil`` SDK's
  ``TinfoilAI`` client (which is OpenAI-shaped) and assert how
  ``get_tinfoil_completion`` builds the request (payload messages, all-text
  ``system`` collapsed to a string, images preserved as arrays), how sampling
  params are forwarded, and how usage is parsed.
* **Live tests** hit real Tinfoil enclaves and are skipped unless the
  ``tinfoil`` package is installed *and* ``TINFOIL_API_KEY`` is set.
"""

import base64
import os
import struct
import zlib

import pytest
from dotenv import load_dotenv
from external_api import tinfoil_api
from external_api.tinfoil_api import (
    ImageURL,
    ImageURLContent,
    TextContent,
    TinfoilMessage,
    get_tinfoil_completion,
)

load_dotenv()


MODEL = "gemma4-31b"
VISION_MODEL = "gemma4-31b"
IMAGE_URL = "https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"


def _response_text(message: TinfoilMessage) -> str:
    return "".join(
        block.text for block in message.content if isinstance(block, TextContent)
    )


def _solid_png_data_uri(width: int = 16, height: int = 16, rgb=(200, 60, 60)) -> str:
    """Build a small solid-color PNG as a base64 data URI (stdlib only).

    Tinfoil (unlike some providers) does NOT fetch remote image URLs server-side
    — images must be embedded as base64 data URLs. Passing a remote URL instead
    stalls the request until the client's long default timeout, so the live
    image test uses an embedded data URI, which also mirrors how real sensing
    sends local screenshots.
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
# Mock layer: stub the OpenAI-shaped ``TinfoilAI`` client and inspect requests.
# --------------------------------------------------------------------------- #


class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)


class _Usage:
    def __init__(self, prompt_tokens, completion_tokens):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens


class _Response:
    def __init__(self, content, usage):
        self.choices = [_Choice(content)]
        self.usage = usage


class _FakeCompletions:
    def __init__(self, parent):
        self._parent = parent

    def create(self, **kwargs):
        self._parent.calls.append(kwargs)
        return self._parent.response


class _FakeChat:
    def __init__(self, parent):
        self.completions = _FakeCompletions(parent)


class _FakeTinfoilAI:
    """Stub TinfoilAI: records construction + chat calls, returns canned values."""

    instances: list["_FakeTinfoilAI"] = []

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.calls: list[dict] = []
        self.response = _Response("Paris", _Usage(12, 3))
        self.chat = _FakeChat(self)
        type(self).instances.append(self)


@pytest.fixture
def fake_tinfoil(monkeypatch):
    _FakeTinfoilAI.instances = []
    monkeypatch.setattr(tinfoil_api, "_import_tinfoil", lambda: _FakeTinfoilAI)
    monkeypatch.setenv("TINFOIL_API_KEY", "test-key")
    return _FakeTinfoilAI


def _last(fake):
    """The most recently constructed fake client (one is built per call)."""
    return fake.instances[-1]


def test_text_only_builds_payload_and_parses(fake_tinfoil):
    """A text-only request forwards params and parses the reply + usage."""
    messages = [
        TinfoilMessage(role="system", content=[TextContent(text="You are terse.")]),
        TinfoilMessage(
            role="user", content=[TextContent(text="What's the capital of France?")]
        ),
    ]

    output, usage = get_tinfoil_completion(
        messages, model=MODEL, api_key="explicit-key", temperature=0.2, max_tokens=128
    )

    assert isinstance(output, TinfoilMessage)
    assert output.role == "assistant"
    assert _response_text(output) == "Paris"
    assert usage["prompt_tokens"] == 12
    assert usage["completion_tokens"] == 3

    client = _last(fake_tinfoil)
    assert client.init_kwargs == {"api_key": "explicit-key"}
    (call,) = client.calls
    assert call["model"] == MODEL
    assert call["temperature"] == 0.2
    assert call["max_tokens"] == 128
    # All-text system/user messages collapse to plain strings.
    assert call["messages"] == [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "What's the capital of France?"},
    ]


def test_omitted_sampling_params_not_sent(fake_tinfoil):
    """Params left as None are omitted so the model's own defaults apply."""
    messages = [TinfoilMessage(role="user", content=[TextContent(text="hi")])]

    get_tinfoil_completion(messages, model=MODEL, api_key="k")

    (call,) = _last(fake_tinfoil).calls
    assert "temperature" not in call
    assert "max_tokens" not in call
    assert "top_p" not in call


def test_text_and_image_preserves_image_block(fake_tinfoil):
    """A multimodal message keeps its array form (image block preserved)."""
    messages = [
        TinfoilMessage(
            role="user",
            content=[
                TextContent(text="Describe this image."),
                ImageURLContent(image_url=ImageURL(url=IMAGE_URL)),
            ],
        )
    ]

    get_tinfoil_completion(messages, model=VISION_MODEL, api_key="k")

    (call,) = _last(fake_tinfoil).calls
    blocks = call["messages"][0]["content"]
    assert [b["type"] for b in blocks] == ["text", "image_url"]
    assert blocks[1]["image_url"]["url"] == IMAGE_URL


def test_dict_messages_pass_through(fake_tinfoil):
    """Raw OpenAI-style dict messages are accepted and forwarded."""
    messages = [{"role": "user", "content": "Say hello."}]

    get_tinfoil_completion(messages, model=MODEL, api_key="k")

    (call,) = _last(fake_tinfoil).calls
    assert call["messages"] == [{"role": "user", "content": "Say hello."}]


def test_missing_api_key_raises(monkeypatch):
    """A clear error is raised when no API key is available (before importing)."""
    monkeypatch.setattr(tinfoil_api, "_import_tinfoil", lambda: _FakeTinfoilAI)
    monkeypatch.delenv("TINFOIL_API_KEY", raising=False)
    messages = [TinfoilMessage(role="user", content=[TextContent(text="hi")])]

    with pytest.raises(ValueError, match="No API key provided"):
        get_tinfoil_completion(messages, model=MODEL, api_key=None)


# --------------------------------------------------------------------------- #
# Live layer: real Tinfoil enclave. Skipped without the SDK + an API key.
# --------------------------------------------------------------------------- #


@pytest.fixture
def live_api_key():
    try:
        import tinfoil  # type: ignore  # noqa: F401
    except ImportError:
        pytest.skip("tinfoil package not installed")
    key = os.getenv("TINFOIL_API_KEY")
    if not key:
        pytest.skip("TINFOIL_API_KEY not set (put it in .env or export it)")
    return key


def test_live_text_only(live_api_key):
    """Real text-only round-trip through a Tinfoil enclave."""
    messages = [
        TinfoilMessage(
            role="user", content=[TextContent(text="What's the capital of France?")]
        )
    ]

    output, usage = get_tinfoil_completion(
        messages, model=MODEL, api_key=live_api_key, temperature=0.2, max_tokens=128
    )

    assert output.role == "assistant"
    assert "paris" in _response_text(output).lower()
    assert usage["completion_tokens"] > 0


def test_live_text_and_image(live_api_key):
    """Real text+image round-trip through a Tinfoil vision model.

    Uses an embedded base64 data URI (not a remote URL): Tinfoil does not fetch
    remote image URLs server-side, so a remote URL would stall the request.
    """
    messages = [
        TinfoilMessage(
            role="user",
            content=[
                TextContent(text="What color is this image? Answer in one word."),
                ImageURLContent(image_url=ImageURL(url=_solid_png_data_uri())),
            ],
        )
    ]

    output, _ = get_tinfoil_completion(
        messages, model=VISION_MODEL, api_key=live_api_key, max_tokens=256
    )

    assert output.role == "assistant"
    assert len(_response_text(output)) > 0
