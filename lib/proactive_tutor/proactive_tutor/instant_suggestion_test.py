from __future__ import annotations

import json

import pytest
from external_api.litellm_api import (
    FunctionCall,
    LiteLLMMessage,
    TextContent,
    ToolCall,
)
from proactive_tutor import instant_suggestion
from proactive_tutor.agents import tutor as tutor_module


@pytest.mark.parametrize(
    ("field", "expected"),
    [
        ("<dimensions>execution,judgment</dimensions>", ["execution", "judgment"]),
        (
            "<dimensions> Learning,LEARNING,unknown,attention,motivation</dimensions>",
            ["learning", "attention"],
        ),
        ("<dimensions>unknown</dimensions>", []),
        ("", []),
    ],
)
def test_support_dimensions_from_xml(field, expected):
    result = instant_suggestion._parse_instant_suggestion(
        f"<suggestion><kind>content</kind><title>Review</title>{field}"
        "<body>Check the source.</body></suggestion>"
    )
    assert result["dimensions"] == expected
    assert result["copyText"] == "Check the source."


@pytest.mark.parametrize(
    ("dimensions", "expected"),
    [
        (["motivation", "attention"], ["motivation", "attention"]),
        ([None, 42, "Judgment", "judgment", "unknown"], ["judgment"]),
        ("execution,learning", ["execution", "learning"]),
        ({"execution": True}, []),
    ],
)
def test_support_dimensions_from_json(dimensions, expected):
    result = instant_suggestion._parse_instant_suggestion(
        json.dumps(
            {
                "kind": "delegate",
                "title": "Review",
                "prompt": "Check the source.",
                "dimensions": dimensions,
            }
        )
    )
    assert result["dimensions"] == expected
    assert result["copyText"] == "Check the source."


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


def test_endpoint_uses_assigned_suggestion_model_and_legacy_fallback(monkeypatch):
    from fastapi.testclient import TestClient
    from proactive_tutor import tutor_server

    models = []

    def generate(*args):
        models.append(args[4])
        return {
            "kind": "content",
            "title": "Suggestion",
            "body": "Done",
            "copyText": "Done",
            "dimensions": ["execution", "learning"],
        }, {}

    monkeypatch.setattr(
        instant_suggestion, "generate_instant_suggestion_with_metrics", generate
    )
    monkeypatch.setattr(tutor_server, "tutor", None)
    monkeypatch.setattr(tutor_server, "configured_model_name", "original-model")
    monkeypatch.setattr(
        tutor_server.TutorSystem, "_load_memory", staticmethod(lambda: "")
    )
    client = TestClient(tutor_server.app)
    monkeypatch.setenv("COCO_INSTANT_SUGGESTION_MODEL", "pi/test/fast")
    response = client.post("/suggestion/instant", json={"observation": "Writing"})
    assert response.status_code == 200
    assert response.json()["dimensions"] == ["execution", "learning"]
    monkeypatch.delenv("COCO_INSTANT_SUGGESTION_MODEL")
    assert (
        client.post("/suggestion/instant", json={"observation": "Writing"}).status_code
        == 200
    )
    assert models == ["pi/test/fast", "original-model"]
