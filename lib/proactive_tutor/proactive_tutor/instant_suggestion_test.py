from __future__ import annotations

from external_api.litellm_api import LiteLLMMessage, TextContent
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


def test_parse_instant_suggestion_allows_abstain_xml() -> None:
    assert instant_suggestion._parse_instant_suggestion(
        "<suggestion><kind>abstain</kind></suggestion>"
    ) == {
        "kind": "abstain",
        "title": "",
        "body": None,
        "targetTool": None,
        "prompt": None,
        "copyText": "",
    }


def test_parse_instant_suggestion_allows_abstain_json() -> None:
    result = instant_suggestion._parse_instant_suggestion('{"kind": "abstain"}')

    assert result["kind"] == "abstain"
    assert result["copyText"] == ""


def test_instant_suggestion_does_not_expose_memory_or_screen_tools(monkeypatch) -> None:
    calls: list[tuple[list[dict], str]] = []

    def fake_completion(messages, **kwargs):
        calls.append(([dict(message) for message in messages], kwargs["operation"]))
        assert kwargs.get("tools") is None
        return (
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
            _metrics("instant-direct"),
        )

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
    assert "get_user_context" not in calls[0][0][0]["content"]
    assert "observe_screen" not in calls[0][0][0]["content"]
    assert [operation for _, operation in calls] == ["instant_suggestion"]
    assert metrics["total_tokens"] == 5
    assert metrics["tool_calls"] == []


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


def test_instant_suggestion_uses_preretrieved_context_without_memory_tool(
    monkeypatch,
) -> None:
    captured: list[list[dict]] = []

    def fake_completion(messages, **kwargs):
        captured.append([dict(message) for message in messages])
        assert kwargs.get("tools") is None
        return (
            LiteLLMMessage(
                role="assistant",
                content=[
                    TextContent(
                        text=(
                            "<suggestion><kind>content</kind>"
                            "<title>Reply to Olga</title>"
                            "<body>Hi Olga, thanks for checking in.</body>"
                            "</suggestion>"
                        )
                    )
                ],
            ),
            _metrics("instant-preretrieved"),
        )

    monkeypatch.setattr(tutor_module, "chat_completion", fake_completion)
    retrieved_context = {
        "query": "Reply to recruiter Outlook internship check-in",
        "results": [
            {
                "id": 42,
                "text": "Olga previously asked about the internship end date.",
                "evidence": {
                    "id": "obs-1",
                    "content": "The user reviewed Olga's extension email.",
                },
            }
        ],
    }

    result, metrics = instant_suggestion.generate_instant_suggestion_with_metrics(
        observation="The user is drafting a reply to Olga.",
        task_label="Reply to the recruiter",
        scenario="everyday_support",
        ai_tools=[],
        model="test-model",
        retrieved_context=retrieved_context,
    )

    assert result["copyText"] == "Hi Olga, thanks for checking in."
    assert "<retrieved_context>" in captured[0][-1]["content"]
    assert (
        "Olga previously asked about the internship end date."
        in captured[0][-1]["content"]
    )
    assert metrics["tool_calls"] == []
