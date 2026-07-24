from __future__ import annotations

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


def test_instant_suggestion_can_retrieve_memory_before_generating(
    monkeypatch,
) -> None:
    responses = iter(
        [
            (
                '<tool_call>{"name":"get_user_context","arguments":'
                '{"query":"status update tone","limit":3,"evidence_limit":1}}'
                "</tool_call>"
            ),
            (
                "<suggestion><kind>content</kind><title>Send status update</title>"
                "<body>Quick update: the launch checklist is on track.</body>"
                "</suggestion>"
            ),
        ]
    )
    prompts: list[tuple[str, str, str]] = []

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

    def fake_completion(model, system_prompt, user_prompt, **kwargs):
        prompts.append((system_prompt, user_prompt, kwargs["operation"]))
        return next(responses), _metrics(f"instant-{len(prompts)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(
        tutor_module,
        "prompt_to_text_with_metrics",
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
    assert "get_user_context" in prompts[0][0]
    assert "observe_screen" not in prompts[0][0]
    assert "concise, direct status updates" in prompts[1][1]
    assert [operation for _, _, operation in prompts] == [
        "instant_suggestion",
        "instant_suggestion",
    ]
    assert metrics["total_tokens"] == 10
    assert metrics["tool_calls"][0]["name"] == "get_user_context"


def test_instant_suggestion_skips_memory_when_not_needed(monkeypatch) -> None:
    def fail_if_called(**kwargs):
        raise AssertionError(f"memory MCP should not run: {kwargs}")

    def fake_completion(model, system_prompt, user_prompt, **kwargs):
        return (
            "<suggestion><kind>content</kind><title>Reply briefly</title>"
            "<body>Sounds good—thank you!</body></suggestion>",
            _metrics("instant-direct"),
        )

    monkeypatch.setattr(tutor_module, "call_get_user_context", fail_if_called)
    monkeypatch.setattr(
        tutor_module,
        "prompt_to_text_with_metrics",
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
