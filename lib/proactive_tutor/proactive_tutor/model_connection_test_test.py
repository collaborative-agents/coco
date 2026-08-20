from external_api.litellm_api import LiteLLMMessage, TextContent
from proactive_tutor import model_connection_test


def test_connection_uses_tiny_multimodal_request(monkeypatch) -> None:
    captured: dict = {}

    def fake_chat_completion(messages, **kwargs):
        captured["messages"] = messages
        captured.update(kwargs)
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="OK")]),
            {},
        )

    monkeypatch.setattr(model_connection_test, "chat_completion", fake_chat_completion)

    assert model_connection_test.test_connection("gemini/test-model", True) == "OK"
    assert captured["max_tokens"] == 8
    assert captured["temperature"] is None
    content = captured["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "Reply only OK."}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_tutor_connection_test_is_text_only(monkeypatch) -> None:
    captured: dict = {}

    def fake_chat_completion(messages, **kwargs):
        captured["messages"] = messages
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="OK")]),
            {},
        )

    monkeypatch.setattr(model_connection_test, "chat_completion", fake_chat_completion)

    model_connection_test.test_connection("anthropic/test-model", False)
    assert captured["messages"][0]["content"] == [
        {"type": "text", "text": "Reply only OK."}
    ]


def test_openai_compatible_test_does_not_inject_vllm_options(monkeypatch) -> None:
    captured: dict = {}

    def fake_chat_completion(messages, **kwargs):
        captured.update(kwargs)
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="OK")]),
            {},
        )

    monkeypatch.setattr(model_connection_test, "chat_completion", fake_chat_completion)

    model_connection_test.test_connection("hosted_vllm/aws/anthropic/model", False)
    assert "extra_body" not in captured
    assert "reasoning_effort" not in captured
