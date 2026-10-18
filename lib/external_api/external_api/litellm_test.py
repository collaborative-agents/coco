"""
`uv run pytest lib/external_api/external_api/litellm_test.py`
"""

from types import SimpleNamespace

from external_api import litellm_api
from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
    get_litellm_completion,
)


def test_text_only_query(monkeypatch):
    """Test a text completion without contacting a real provider."""
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {
            "choices": [{"message": {"content": "Paris"}}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 1},
        }

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    messages = [
        LiteLLMMessage(
            role="user",
            content=[TextContent(text="What's the capital of France?")],
        )
    ]

    output, usage = get_litellm_completion(messages, model="test/model")

    assert isinstance(output, LiteLLMMessage)
    assert output.role == "assistant"
    assert output.content[0].text == "Paris"
    assert usage["prompt_tokens"] == 8
    assert usage["completion_tokens"] == 1
    assert captured["model"] == "test/model"
    assert captured["messages"] == [
        {
            "role": "user",
            "content": [{"type": "text", "text": "What's the capital of France?"}],
        }
    ]


def test_gemini_3_omits_deprecated_sampling_parameters(monkeypatch):
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    get_litellm_completion(
        [{"role": "user", "content": "Hello"}],
        model="gemini/gemini-3-flash-preview",
        temperature=0.2,
        top_p=0.8,
    )

    assert "temperature" not in captured
    assert "top_p" not in captured


def test_image_query(monkeypatch):
    """Test image message serialization without downloading or inference."""
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {
            "choices": [{"message": {"content": "A dog"}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 2},
        }

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    messages = [
        LiteLLMMessage(
            role="user",
            content=[
                TextContent(text="Describe this image"),
                ImageURLContent(
                    image_url=ImageURL(
                        url="https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"
                    ),
                ),
            ],
        )
    ]

    output, _ = get_litellm_completion(messages, model="test/model")

    assert output.content[0].text == "A dog"
    assert captured["messages"][0]["content"][1] == {
        "type": "image_url",
        "image_url": {
            "url": "https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"
        },
    }


def test_streaming_completion_collects_chunks_and_usage(monkeypatch) -> None:
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return iter(
            [
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello "))],
                    usage=None,
                ),
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="world"))],
                    usage=SimpleNamespace(
                        prompt_tokens=7,
                        completion_tokens=2,
                    ),
                ),
            ]
        )

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    chunks: list[str] = []

    output, usage = get_litellm_completion(
        [{"role": "user", "content": "Say hello"}],
        model="test/model",
        stream=True,
        on_chunk=chunks.append,
    )

    assert output.content[0].text == "Hello world"
    assert chunks == ["Hello ", "world"]
    assert usage["prompt_tokens"] == 7
    assert usage["completion_tokens"] == 2
    assert captured["stream"] is True
    assert captured["stream_options"] == {"include_usage": True}


def test_router_configuration_preserves_multimodal_payload(monkeypatch) -> None:
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {
            "choices": [{"message": {"content": "BLUE 472"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    monkeypatch.setenv("LLM_ROUTER_URL", "https://router.example.test")
    monkeypatch.setenv("LLM_ROUTER_API_KEY", "router-test-key")
    image = "data:image/png;base64,AAAA"

    get_litellm_completion(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Read the image"},
                    {"type": "image_url", "image_url": {"url": image}},
                ],
            }
        ],
        model="gemini/gemini-2.5-pro",
    )

    assert captured["model"] == "gemini/gemini-2.5-pro"
    assert captured["api_base"] == "https://router.example.test/v1"
    assert captured["api_key"] == "router-test-key"
    assert captured["custom_llm_provider"] == "openai"
    assert captured["messages"][0]["content"][1]["image_url"]["url"] == image


def test_router_configuration_requires_router_key(monkeypatch) -> None:
    monkeypatch.setenv("LLM_ROUTER_URL", "https://router.example.test")
    monkeypatch.delenv("LLM_ROUTER_API_KEY", raising=False)

    try:
        get_litellm_completion(
            [{"role": "user", "content": "Hello"}],
            model="gemini/gemini-2.5-pro",
        )
    except RuntimeError as error:
        assert "LLM_ROUTER_API_KEY" in str(error)
    else:
        raise AssertionError("Expected a missing router key error")
