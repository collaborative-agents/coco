"""Integration tests for NVIDIA InferenceHub.

```
uv run pytest lib/external_api/external_api/nv_inference_api_test.py -v
```
"""

import os
from types import SimpleNamespace

import external_api.nv_inference_api as nv_inference_api
import pytest
from dotenv import load_dotenv
from external_api.nv_inference_api import (
    ImageURL,
    ImageURLContent,
    NVInferenceMessage,
    TextContent,
    get_nv_inference_completion,
)

load_dotenv()

MODEL = "aws/anthropic/bedrock-claude-sonnet-4-6"
VISION_MODEL = "aws/anthropic/bedrock-claude-sonnet-4-6"


@pytest.fixture
def api_key():
    key = os.getenv("NV_INFERENCE_API_KEY")
    if not key:
        pytest.skip("NV_INFERENCE_API_KEY environment variable not set")
    return key


def _response_text(message: NVInferenceMessage) -> str:
    return "".join(
        block.text for block in message.content if isinstance(block, TextContent)
    )


def test_text_only_query(api_key):
    """Completion with a text-only query."""
    messages = [
        NVInferenceMessage(
            role="user",
            content=[TextContent(text="What's the capital of France?")],
        )
    ]

    output, usage = get_nv_inference_completion(
        messages, model=MODEL, api_key=api_key, temperature=0.2, max_tokens=128
    )

    assert isinstance(output, NVInferenceMessage)
    assert output.role == "assistant"
    assert "paris" in _response_text(output).lower()
    assert usage["completion_tokens"] > 0
    assert usage["prompt_tokens"] > 0


def test_streaming_query(api_key):
    """Streaming completion accumulates content and invokes the callback."""
    messages = [
        NVInferenceMessage(
            role="user",
            content=[
                TextContent(text="Write a limerick about the wonders of GPU computing.")
            ],
        )
    ]

    chunks: list[str] = []
    output, usage = get_nv_inference_completion(
        messages,
        model=MODEL,
        api_key=api_key,
        temperature=0.2,
        max_tokens=256,
        stream=True,
        on_chunk=chunks.append,
    )

    streamed = "".join(chunks)
    assert len(streamed) > 0
    assert _response_text(output) == streamed
    assert usage["completion_tokens"] > 0


def test_dict_messages(api_key):
    """Raw OpenAI-style dict messages are accepted."""
    messages = [{"role": "user", "content": "Say 'hello' and nothing else."}]

    output, _ = get_nv_inference_completion(
        messages, model=MODEL, api_key=api_key, max_tokens=32
    )

    assert "hello" in _response_text(output).lower()


def test_native_function_call(api_key):
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_user_context",
                "description": "Retrieve relevant user context.",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }
    ]

    output, _ = get_nv_inference_completion(
        [{"role": "user", "content": "Look up my current project."}],
        model=MODEL,
        api_key=api_key,
        max_tokens=128,
        tools=tools,
        tool_choice={
            "type": "function",
            "function": {"name": "get_user_context"},
        },
    )

    assert len(output.tool_calls) == 1
    assert output.tool_calls[0].function.name == "get_user_context"


def test_native_function_call_arguments_are_forwarded(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=None,
                            tool_calls=[
                                SimpleNamespace(
                                    id="call-1",
                                    function=SimpleNamespace(
                                        name="get_user_context",
                                        arguments='{"query":"current project"}',
                                    ),
                                )
                            ],
                        )
                    )
                ],
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4),
            )

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(nv_inference_api, "OpenAI", FakeOpenAI)
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_user_context",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    output, _ = get_nv_inference_completion(
        [{"role": "user", "content": "Look up my project."}],
        model=MODEL,
        api_key="test-key",
        tools=tools,
        tool_choice="auto",
    )

    assert captured["tools"] == tools
    assert captured["tool_choice"] == "auto"
    assert output.tool_calls[0].function.name == "get_user_context"


def test_image_query(api_key):
    """Completion with an image URL (requires a vision-capable model)."""
    messages = [
        NVInferenceMessage(
            role="user",
            content=[
                TextContent(text="Describe this image in one sentence."),
                ImageURLContent(
                    image_url=ImageURL(
                        url="https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"
                    )
                ),
            ],
        )
    ]

    output, _ = get_nv_inference_completion(
        messages, model=VISION_MODEL, api_key=api_key, max_tokens=256
    )

    assert len(_response_text(output)) > 0


def test_missing_api_key_raises(monkeypatch):
    """A clear error is raised when no API key is available."""
    monkeypatch.delenv("NV_INFERENCE_API_KEY", raising=False)
    messages = [
        NVInferenceMessage(role="user", content=[TextContent(text="hi")]),
    ]

    with pytest.raises(ValueError, match="No API key provided"):
        get_nv_inference_completion(messages, model=MODEL, api_key=None)
