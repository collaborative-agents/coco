from types import SimpleNamespace

from external_api import llm, tinker_oai_api
from external_api.litellm_api import LiteLLMMessage, TextContent
from external_api.types import TokenUsage


def test_tinker_adapter_preserves_audio_and_native_tools(monkeypatch):
    captured = {}
    tool_call = SimpleNamespace(
        id="memory-1",
        function=SimpleNamespace(name="get_user_context", arguments='{"query":""}'),
    )
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=None, tool_calls=[tool_call])
            )
        ],
        usage=SimpleNamespace(
            prompt_tokens=9,
            completion_tokens=3,
            prompt_tokens_details=SimpleNamespace(cached_tokens=2),
        ),
    )

    def create(**kwargs):
        captured.update(kwargs)
        return response

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))
    )
    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_oai_api, "OpenAI", lambda **_kwargs: client)
    audio_block = {
        "type": "input_audio",
        "input_audio": {"data": "wav-base64", "format": "wav"},
    }

    output, usage = tinker_oai_api.get_tinker_oai_completion(
        [{"role": "user", "content": [audio_block]}],
        model="thinkingmachines/Inkling-Small:peft:262144",
        reasoning_effort="none",
        tools=[{"type": "function", "function": {"name": "memory"}}],
        tool_choice="auto",
    )

    assert captured["messages"][0]["content"] == [audio_block]
    assert captured["reasoning_effort"] == "none"
    assert output.tool_calls[0].function.name == "get_user_context"
    assert usage["prompt_tokens"] == 9
    assert usage["cache_read_input_tokens"] == 2


def test_tinker_model_prefix_routes_to_adapter(monkeypatch):
    captured = {}

    def fake_tinker(messages, **kwargs):
        captured["messages"] = messages
        captured.update(kwargs)
        return (
            LiteLLMMessage(
                role="assistant",
                content=[TextContent(text="heard")],
            ),
            TokenUsage(prompt_tokens=1, completion_tokens=1),
        )

    monkeypatch.setattr(llm, "get_tinker_oai_completion", fake_tinker)
    output, metrics = llm.chat_completion(
        [{"role": "user", "content": "hello"}],
        model="tinker/thinkingmachines/Inkling-Small:peft:262144",
        reasoning_effort="none",
    )

    assert output.content[0].text == "heard"
    assert captured["model"] == "thinkingmachines/Inkling-Small:peft:262144"
    assert captured["reasoning_effort"] == "none"
    assert metrics["provider"] == "tinker"
