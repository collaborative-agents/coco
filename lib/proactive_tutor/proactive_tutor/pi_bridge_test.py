import json
from types import SimpleNamespace

import pytest
from external_api.litellm_api import FunctionCall, LiteLLMMessage, ToolCall
from fastapi import FastAPI
from fastapi.testclient import TestClient
from proactive_tutor import pi_bridge


@pytest.fixture
def bridge(monkeypatch):
    monkeypatch.setenv("COCO_PI_BRIDGE_TOKEN", "secret")
    calls = []
    agent = SimpleNamespace(
        model="configured/model",
        prompt="Be helpful.",
        _tool_definitions=lambda: [
            {"type": "function", "function": {"name": "observe_screen"}}
        ],
        _execute_tool_call=lambda call: (
            calls.append(call) or {"observation": "A spreadsheet"}
        ),
    )
    tutor = SimpleNamespace(
        tutor_agent=agent,
        problem_statement="Current task",
        memory="User memory",
        conversation_history=["Earlier suggestion"],
        _chat_messages=[],
        _user_name_context_block=lambda: "User",
        _ai_tools_context_block=lambda: "Tools",
        _curriculum_context_block=lambda: "Curriculum",
    )
    app = FastAPI()
    app.include_router(pi_bridge.create_pi_router(lambda: tutor))
    return TestClient(app), tutor, calls


def test_bridge_requires_desktop_token(bridge):
    client, _, _ = bridge
    assert client.get("/agent/context").status_code == 401
    assert (
        client.get(
            "/agent/context", headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    response = client.get("/agent/context", headers={"Authorization": "Bearer secret"})
    assert response.json()["tools"][0]["function"]["name"] == "observe_screen"


def test_bridge_uses_existing_tools_and_records_turn_for_other_coco_flows(bridge):
    client, tutor, calls = bridge
    client.headers["Authorization"] = "Bearer secret"
    response = client.post(
        "/agent/tools/execute",
        json={"name": "observe_screen", "arguments": {"focus": "error"}},
    )
    assert response.json()["observation"] == "A spreadsheet"
    assert calls == [{"name": "observe_screen", "arguments": {"focus": "error"}}]
    response = client.post("/agent/turn", json={"user_text": "Do it", "text": "Done"})
    assert response.json()["history_length"] == 3
    assert tutor._chat_messages[-1] == {"role": "assistant", "content": "Done"}


def test_completion_preserves_tools_and_streaming_while_using_configured_model(
    bridge, monkeypatch
):
    client, _, _ = bridge
    client.headers["Authorization"] = "Bearer secret"
    received = {}

    def completion(messages, **kwargs):
        received.update(kwargs)
        kwargs["on_chunk"]("Working…")
        return LiteLLMMessage(
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call-1",
                    function=FunctionCall(
                        name="write", arguments='{"path":"out.txt","content":"ok"}'
                    ),
                )
            ],
        ), {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}

    monkeypatch.setattr(pi_bridge, "chat_completion", completion)
    tools = [
        {
            "type": "function",
            "function": {"name": "write", "parameters": {"type": "object"}},
        }
    ]
    response = client.post(
        "/agent/v1/chat/completions",
        json={
            "model": "untrusted/override",
            "messages": [{"role": "user", "content": "Do it"}],
            "tools": tools,
        },
    )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]
    assert received["model"] == "configured/model"
    assert received["tools"] == tools
    assert any(
        event["choices"][0]["delta"].get("content") == "Working…" for event in events
    )
    assert (
        events[-2]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"]
        == "write"
    )
    assert events[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert events[-1]["usage"]["total_tokens"] == 15
    assert response.text.endswith("data: [DONE]\n\n")


def test_completion_failure_is_reported_in_stream(bridge, monkeypatch):
    client, _, _ = bridge
    client.headers["Authorization"] = "Bearer secret"

    def fail(*args, **kwargs):
        raise RuntimeError("Provider unavailable")

    monkeypatch.setattr(pi_bridge, "chat_completion", fail)
    response = client.post("/agent/v1/chat/completions", json={"messages": []})
    assert "Provider unavailable" in response.text
    assert '"error"' in response.text
