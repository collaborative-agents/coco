"""
`uv run pytest lib/external_api/external_api/litellm_test.py`
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from external_api import litellm_api
from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
    get_litellm_completion,
)


def test_hosted_models_use_per_request_routes(monkeypatch):
    routes = {
        "hosted_vllm/Qwen/Qwen3.5-9B": {
            "api_base": "http://local.test/v1",
            "api_key": "local-key",
        },
        "hosted_vllm/cloud/chat": {
            "api_base": "https://cloud.test/v1",
            "api_key": "cloud-key",
        },
    }
    monkeypatch.setenv("COCO_HOSTED_MODEL_ROUTES", json.dumps(routes))
    monkeypatch.setenv("HOSTED_VLLM_API_BASE", "https://wrong.test/v1")
    monkeypatch.setenv("HOSTED_VLLM_API_KEY", "wrong-key")

    def fake_completion(**kwargs):
        route = routes[kwargs["model"]]
        assert kwargs["api_base"] == route["api_base"]
        assert kwargs["api_key"] == route["api_key"]
        assert os.environ["HOSTED_VLLM_API_BASE"] == "https://wrong.test/v1"
        assert os.environ["HOSTED_VLLM_API_KEY"] == "wrong-key"
        if kwargs["stream"]:
            return iter(
                [
                    SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                delta=SimpleNamespace(content="OK", tool_calls=[])
                            )
                        ]
                    )
                ]
            )
        return {"choices": [{"message": {"content": "OK"}}], "usage": {}}

    monkeypatch.setattr(litellm_api, "completion", fake_completion)

    def call(model):
        for stream in (False, True):
            reply, _ = get_litellm_completion(
                [{"role": "user", "content": "Hello"}], model=model, stream=stream
            )
            assert reply.content[0].text == "OK"

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(call, list(routes) * 3))

    with pytest.raises(ValueError, match="No endpoint configured"):
        get_litellm_completion([], model="hosted_vllm/missing")


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


@pytest.mark.parametrize("field", ["reasoning_content", "reasoning", "reasoning_text"])
def test_qwen_bridge_preserves_structured_reasoning(monkeypatch, field):
    from external_api.llm import chat_completion

    monkeypatch.delenv("COCO_HOSTED_MODEL_ROUTES", raising=False)
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return iter(
            [
                SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(
                                **{
                                    field: "Think first.",
                                    "content": None,
                                }
                            )
                        )
                    ]
                ),
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="Answer."))]
                ),
            ]
        )

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    text, reasoning = [], []
    response, _ = chat_completion(
        [{"role": "user", "content": "Hi"}],
        model="hosted_vllm/nvidia/Qwen3.8-27B-NVFP4",
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        on_chunk=text.append,
        on_reasoning_chunk=reasoning.append,
    )
    assert text == ["Answer."]
    assert reasoning == ["Think first."]
    assert response.content[0].text == "Answer."
    assert captured["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("opening", ["", "<think>"])
def test_configured_qwen_thinking_is_removed_from_answer(monkeypatch, stream, opening):
    from external_api.llm import chat_completion

    model = "hosted_vllm/nvidia/Qwen3.8-27B-NVFP4"
    monkeypatch.delenv("COCO_HOSTED_MODEL_ROUTES", raising=False)
    raw = opening + "Plan carefully.</think>Final answer."

    def fake_completion(**kwargs):
        assert kwargs["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True
        if not stream:
            return {"choices": [{"message": {"content": raw}}], "usage": {}}
        return iter(
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content=char))]
            )
            for char in raw
        )

    monkeypatch.setattr(litellm_api, "completion", fake_completion)
    chunks, reasoning = [], []
    response, _ = chat_completion(
        [],
        model=model,
        extra_body={"chat_template_kwargs": {"enable_thinking": True}},
        on_chunk=chunks.append if stream else None,
        on_reasoning_chunk=reasoning.append,
    )
    assert response.content[0].text == "Final answer."
    if stream:
        assert "".join(chunks) == "Final answer."
        assert "".join(reasoning) == "Plan carefully."
