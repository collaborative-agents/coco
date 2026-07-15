"""Test the LLM metrics functionality.

```
# Run mock tests only
uv run pytest lib/external_api/external_api/llm_metrics_test.py

# Run the real provider tests
RUN_LIVE_LLM_TESTS=1 LIVE_LLM_MODEL=live_llm_model \
    uv run pytest lib/external_api/external_api/llm_metrics_test.py --capture=tee-sys

"""

import os

import pytest
from dotenv import load_dotenv
from external_api import llm
from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
)
from external_api.types import TokenUsage

load_dotenv()

LIVE_LLM_MODEL = os.getenv("LIVE_LLM_MODEL", "gemini/gemini-3-flash-preview")


def _fake_clock(monkeypatch, *, start_time: float, end_time: float) -> None:
    time_values = iter([start_time, end_time])
    perf_values = iter([10.0, 10.0 + (end_time - start_time)])
    monkeypatch.setattr(llm.time, "time", lambda: next(time_values))
    monkeypatch.setattr(llm.time, "perf_counter", lambda: next(perf_values))


def test_chat_completion_returns_token_metrics_and_latency(monkeypatch):
    _fake_clock(monkeypatch, start_time=1000.0, end_time=1000.75)

    def fake_completion(*args, **kwargs):
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="done")]),
            TokenUsage(
                prompt_tokens=23,
                completion_tokens=7,
                cache_creation_input_tokens=3,
                cache_read_input_tokens=5,
            ),
        )

    monkeypatch.setattr(llm, "get_litellm_completion", fake_completion)

    output, metrics = llm.chat_completion(
        [
            LiteLLMMessage(
                role="user",
                content=[TextContent(text="Say done")],
            )
        ],
        model="anthropic/claude-sonnet-test",
        operation="unit_test",
    )

    assert output.content[0].text == "done"  # type: ignore
    assert metrics["prompt_tokens"] == 23
    assert metrics["input_tokens"] == 23
    assert metrics["completion_tokens"] == 7
    assert metrics["output_tokens"] == 7
    assert metrics["total_tokens"] == 30
    assert metrics["cache_creation_input_tokens"] == 3
    assert metrics["cache_read_input_tokens"] == 5
    assert metrics["duration_ms"] == 750.0
    assert metrics["started_at"] == 1000.0
    assert metrics["ended_at"] == 1000.75
    assert metrics["operation"] == "unit_test"
    assert metrics["model"] == "anthropic/claude-sonnet-test"
    assert metrics["provider"] == "litellm"
    assert metrics["modality"] == "llm"
    assert metrics["success"] is True
    assert metrics["error"] is None
    assert metrics["call_id"]


def test_chat_completion_marks_image_requests_as_vlm(monkeypatch):
    _fake_clock(monkeypatch, start_time=5.0, end_time=5.125)

    def fake_completion(*args, **kwargs):
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="seen")]),
            TokenUsage(
                prompt_tokens=101,
                completion_tokens=9,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
            ),
        )

    monkeypatch.setattr(llm, "get_litellm_completion", fake_completion)

    _, metrics = llm.chat_completion(
        [
            LiteLLMMessage(
                role="user",
                content=[
                    TextContent(text="Describe this image"),
                    ImageURLContent(
                        image_url=ImageURL(url="data:image/png;base64,AA==")
                    ),
                ],
            )
        ],
        model="gemini/gemini-test",
    )

    assert metrics["modality"] == "vlm"
    assert metrics["prompt_tokens"] == 101
    assert metrics["completion_tokens"] == 9
    assert metrics["duration_ms"] == 125.0


def test_prompt_to_text_with_metrics_propagates_tokens_and_latency(monkeypatch):
    _fake_clock(monkeypatch, start_time=42.0, end_time=42.333)

    def fake_completion(messages, *args, **kwargs):
        assert messages[0].role == "system"
        assert messages[1].role == "user"
        return (
            LiteLLMMessage(role="assistant", content=[TextContent(text="guidance")]),
            TokenUsage(
                prompt_tokens=88,
                completion_tokens=12,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
            ),
        )

    monkeypatch.setattr(llm, "get_litellm_completion", fake_completion)

    text, metrics = llm.prompt_to_text_with_metrics(
        model="openai/test-model",
        system_prompt="You are helpful.",
        user_prompt="Help me.",
        operation="tutor",
    )

    assert text == "guidance"
    assert metrics["operation"] == "tutor"
    assert metrics["prompt_tokens"] == 88
    assert metrics["input_tokens"] == 88
    assert metrics["completion_tokens"] == 12
    assert metrics["output_tokens"] == 12
    assert metrics["total_tokens"] == 100
    assert metrics["duration_ms"] == 333.0


@pytest.mark.skipif(
    os.getenv("RUN_LIVE_LLM_TESTS") != "1",
    reason="Set RUN_LIVE_LLM_TESTS=1 to run a real provider completion.",
)
def test_chat_completion_live_provider_reports_tokens_and_latency():
    output, metrics = llm.chat_completion(
        [
            LiteLLMMessage(
                role="user",
                content=[TextContent(text="Reply with exactly one word: pong")],
            )
        ],
        model=LIVE_LLM_MODEL,
        max_tokens=16,
        operation="live_unit_test",
    )

    print(
        "live metrics: "
        f"token_in={metrics['input_tokens']} "
        f"token_out={metrics['output_tokens']} "
        f"latency_ms={metrics['duration_ms']}"
    )

    assert output.role == "assistant"
    assert output.content[0].text.strip()  # type: ignore
    assert metrics["operation"] == "live_unit_test"
    assert metrics["model"] == LIVE_LLM_MODEL
    assert metrics["prompt_tokens"] > 0
    assert metrics["input_tokens"] == metrics["prompt_tokens"]
    assert metrics["completion_tokens"] > 0
    assert metrics["output_tokens"] == metrics["completion_tokens"]
    assert metrics["total_tokens"] == (
        metrics["prompt_tokens"] + metrics["completion_tokens"]
    )
    assert metrics["duration_ms"] > 0
    assert metrics["ended_at"] >= metrics["started_at"]
    assert metrics["success"] is True
    assert metrics["error"] is None
