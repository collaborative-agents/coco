from __future__ import annotations

import json

from external_api.litellm_api import (
    FunctionCall,
    LiteLLMMessage,
    TextContent,
    ToolCall,
)
from proactive_tutor import instant_suggestion
from proactive_tutor.agents import tutor as tutor_module


def _metrics(call_id: str) -> dict:
    return {
        "call_id": call_id,
        "operation": "instant_suggestion",
        "model": "test-model",
        "provider": "test",
        "modality": "llm",
        "prompt_tokens": 4,
        "completion_tokens": 1,
        "input_tokens": 4,
        "output_tokens": 1,
        "total_tokens": 5,
        "duration_ms": 10.0,
        "started_at": 100.0,
        "ended_at": 100.01,
        "success": True,
        "error": None,
    }


def test_worker_prompt_allows_launchable_delegate_suggestions() -> None:
    prompt = instant_suggestion._load_instant_system_prompt("ai_upskilling")

    assert "<kind>delegate</kind>" in prompt
    assert "<targetTool>chatgpt</targetTool>" in prompt
    assert "ready-to-paste Stage, Task, and Rules prompt" in prompt
    assert "If no tools are provided, always return `content`" in prompt


def test_instant_suggestion_can_retrieve_memory_before_generating(
    monkeypatch,
) -> None:
    responses = iter(
        [
            LiteLLMMessage(
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id="call-1",
                        function=FunctionCall(
                            name="get_user_context",
                            arguments=json.dumps(
                                {
                                    "query": "status update tone",
                                    "limit": 3,
                                    "evidence_limit": 1,
                                }
                            ),
                        ),
                    )
                ],
            ),
            LiteLLMMessage(
                role="assistant",
                content=[
                    TextContent(
                        text=(
                            "<suggestion><kind>content</kind>"
                            "<title>Send status update</title>"
                            "<body>Quick update: the launch checklist is on "
                            "track.</body></suggestion>"
                        )
                    )
                ],
            ),
        ]
    )
    calls: list[tuple[list[dict], str]] = []

    async def fake_memory_mcp(**kwargs):
        assert kwargs["query"] == "status update tone"
        return {
            "count": 1,
            "results": [
                {
                    "text": "The user prefers concise, direct status updates.",
                }
            ],
        }

    def fake_completion(messages, **kwargs):
        calls.append(([dict(message) for message in messages], kwargs["operation"]))
        return next(responses), _metrics(f"instant-{len(calls)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(
        tutor_module,
        "chat_completion",
        fake_completion,
    )

    result, metrics = instant_suggestion.generate_instant_suggestion_with_metrics(
        observation="The user is drafting a launch status update.",
        task_label="Launch update",
        scenario="everyday_support",
        ai_tools=["chatgpt"],
        model="test-model",
    )

    assert result["kind"] == "content"
    assert result["copyText"] == "Quick update: the launch checklist is on track."
    assert "get_user_context" in calls[0][0][0]["content"]
    assert "observe_screen" not in calls[0][0][0]["content"]
    assert "concise, direct status updates" in calls[1][0][-1]["content"]
    assert [operation for _, operation in calls] == [
        "instant_suggestion",
        "instant_suggestion",
    ]
    assert metrics["total_tokens"] == 10
    assert metrics["tool_calls"][0]["name"] == "get_user_context"


def test_instant_suggestion_skips_memory_when_not_needed(monkeypatch) -> None:
    def fail_if_called(**kwargs):
        raise AssertionError(f"memory MCP should not run: {kwargs}")

    def fake_completion(messages, **kwargs):
        return (
            LiteLLMMessage(
                role="assistant",
                content=[
                    TextContent(
                        text=(
                            "<suggestion><kind>content</kind>"
                            "<title>Reply briefly</title>"
                            "<body>Sounds good—thank you!</body></suggestion>"
                        )
                    )
                ],
            ),
            _metrics("instant-direct"),
        )

    monkeypatch.setattr(tutor_module, "call_get_user_context", fail_if_called)
    monkeypatch.setattr(
        tutor_module,
        "chat_completion",
        fake_completion,
    )

    result, metrics = instant_suggestion.generate_instant_suggestion_with_metrics(
        observation="The user needs to acknowledge a confirmation.",
        task_label=None,
        scenario="everyday_support",
        ai_tools=[],
        model="test-model",
    )

    assert result["copyText"] == "Sounds good—thank you!"
    assert metrics["tool_calls"] == []
