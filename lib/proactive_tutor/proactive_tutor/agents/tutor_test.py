from __future__ import annotations

import json

from external_api.litellm_api import (
    FunctionCall,
    LiteLLMMessage,
    TextContent,
    ToolCall,
)
from proactive_tutor.agents import tutor as tutor_module
from proactive_tutor.agents.tutor import TutorAgent


def _metrics(call_id: str, tokens: int = 5) -> dict:
    return {
        "call_id": call_id,
        "operation": "tutor",
        "model": "test-model",
        "provider": "test",
        "modality": "llm",
        "prompt_tokens": tokens - 1,
        "completion_tokens": 1,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "input_tokens": tokens - 1,
        "output_tokens": 1,
        "total_tokens": tokens,
        "duration_ms": 10.0,
        "started_at": 100.0,
        "ended_at": 100.01,
        "success": True,
        "error": None,
    }


def _memory_result() -> dict:
    return {
        "query": "roadmap",
        "count": 1,
        "results": [
            {
                "id": "memory-1",
                "text": "The user is reviewing a roadmap in Notion",
                "evidence": [
                    {
                        "id": "observation-1",
                        "content": "Reviewing a roadmap in Notion",
                    }
                ],
            }
        ],
    }


def _tool_response(
    name: str,
    arguments: dict,
    *,
    call_id: str = "call-1",
) -> LiteLLMMessage:
    return LiteLLMMessage(
        role="assistant",
        tool_calls=[
            ToolCall(
                id=call_id,
                function=FunctionCall(
                    name=name,
                    arguments=json.dumps(arguments),
                ),
            )
        ],
    )


def _text_response(text: str) -> LiteLLMMessage:
    return LiteLLMMessage(
        role="assistant",
        content=[TextContent(text=text)],
    )


def test_tool_call_uses_memory_mcp(monkeypatch) -> None:
    captured: dict = {}

    async def fake_memory_mcp(**kwargs):
        captured.update(kwargs)
        return _memory_result()

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    agent = TutorAgent("test-model", "system")

    result = agent._execute_tool_call(
        {
            "name": "get_user_context",
            "arguments": {
                "query": "roadmap",
                "start_hh_mm_ago": "02:00",
                "end_hh_mm_ago": "00:15",
                "limit": 3,
                "evidence_limit": 1,
            },
        }
    )

    assert result == _memory_result()
    assert captured == {
        "query": "roadmap",
        "start_hh_mm_ago": "02:00",
        "end_hh_mm_ago": "00:15",
        "limit": 3,
        "evidence_limit": 1,
    }


def test_tool_call_gets_recent_observations(monkeypatch) -> None:
    captured: dict = {}
    expected = {
        "count": 1,
        "observations": [{"id": "recent", "content": "Editing in Figma"}],
    }

    async def fake_recent_observations(**kwargs):
        captured.update(kwargs)
        return expected

    monkeypatch.setattr(
        tutor_module,
        "call_get_recent_observations",
        fake_recent_observations,
    )
    agent = TutorAgent("test-model", "system")

    result = agent._execute_tool_call(
        {
            "name": "get_recent_observations",
            "arguments": {
                "limit": 5,
                "start_hh_mm_ago": "01:00",
                "session_id": "session-1",
                "observation_type": "snapshot",
            },
        }
    )

    assert result == expected
    assert captured == {
        "limit": 5,
        "start_hh_mm_ago": "01:00",
        "session_id": "session-1",
        "observation_type": "snapshot",
    }


def test_tool_call_observes_screen_only_when_requested(monkeypatch) -> None:
    captured: dict = {}
    expected = {
        "observation": "A spreadsheet shows a #VALUE! error in cell D12.",
        "llm_metrics": {"total_tokens": 42},
    }

    def fake_screen_observer(focus: str):
        captured["focus"] = focus
        return expected

    monkeypatch.setattr(tutor_module, "_call_screen_observer", fake_screen_observer)
    agent = TutorAgent("test-model", "system")

    result = agent._execute_tool_call(
        {
            "name": "observe_screen",
            "arguments": {"focus": "Identify the visible spreadsheet error"},
        }
    )

    assert result == expected
    assert captured == {"focus": "Identify the visible spreadsheet error"}


def test_tool_rejects_non_mcp_tool_and_unexpected_arguments() -> None:
    agent = TutorAgent("test-model", "system")

    wrong_tool = agent._execute_tool_call({"name": "unknown_tool", "arguments": {}})
    wrong_argument = agent._execute_tool_call(
        {"name": "get_user_context", "arguments": {"path": "/tmp"}}
    )

    assert wrong_tool["error"] == "tool is not available: unknown_tool"
    assert "unexpected arguments: path" in wrong_argument["error"]


def test_tutor_executes_memory_mcp_and_synthesizes_answer(monkeypatch) -> None:
    responses = iter(
        [
            _tool_response(
                "get_user_context",
                {"query": "roadmap", "limit": 3, "evidence_limit": 1},
            ),
            _text_response(
                "<guidance>The roadmap review appears to be your current "
                "task.</guidance>"
            ),
        ]
    )
    calls: list[list[dict]] = []

    async def fake_memory_mcp(**kwargs):
        assert kwargs["query"] == "roadmap"
        return _memory_result()

    def fake_completion(messages, **kwargs):
        calls.append([dict(message) for message in messages])
        return next(responses), _metrics(f"call-{len(calls)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(tutor_module, "chat_completion", fake_completion)
    monkeypatch.setattr(
        tutor_module,
        "_current_datetime_context",
        lambda: "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
    )
    agent = TutorAgent("test-model", "base system")

    response, metrics = agent.tutor_with_metrics("current context")

    assert response.startswith("<guidance>The roadmap")
    assert "get_user_context" in calls[0][0]["content"]
    assert "2026-07-23T12:34:56-07:00" in calls[0][0]["content"]
    assert calls[1][-1]["role"] == "tool"
    assert "reviewing a roadmap in Notion" in calls[1][-1]["content"]
    assert metrics["total_tokens"] == 10


def test_tutor_skips_tool_loop_when_disabled(monkeypatch) -> None:
    calls: list[list[dict]] = []
    completion_kwargs: list[dict] = []

    def fake_completion(messages, **kwargs):
        calls.append([dict(message) for message in messages])
        completion_kwargs.append(kwargs)
        return _text_response("final guidance"), _metrics("single-call")

    monkeypatch.setattr(tutor_module, "chat_completion", fake_completion)
    monkeypatch.setattr(
        tutor_module,
        "_current_datetime_context",
        lambda: "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
    )
    agent = TutorAgent(
        "test-model",
        "base system",
        enable_memory_tool=False,
        enable_screen_tool=False,
    )

    response, metrics = agent.tutor_with_metrics("context")

    assert response == "final guidance"
    assert len(calls) == 1
    assert completion_kwargs[0]["temperature"] is None
    assert calls[0][0]["content"] == (
        "base system\n\n<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>"
    )
    assert calls[0][1] == {"role": "user", "content": "context"}
    assert metrics["call_id"] == "single-call"


def test_chat_does_not_observe_screen_without_tool_call(monkeypatch) -> None:
    def fail_if_called(_focus: str):
        raise AssertionError("screen observer should not run")

    def fake_chat(messages, **kwargs):
        return (
            LiteLLMMessage(
                role="assistant",
                content=[TextContent(text="A direct answer needs no screen context.")],
            ),
            _metrics("chat-direct"),
        )

    monkeypatch.setattr(tutor_module, "_call_screen_observer", fail_if_called)
    monkeypatch.setattr(tutor_module, "chat_completion", fake_chat)
    agent = TutorAgent("test-model", "base system")

    response, metrics = agent.chat_with_metrics(
        [{"role": "user", "content": "What is two plus two?"}]
    )

    assert response == "A direct answer needs no screen context."
    assert metrics["tool_calls"] == []


def test_attached_screenshot_prompt_discourages_duplicate_capture(
    monkeypatch,
    tmp_path,
) -> None:
    captured: dict = {}
    image_path = tmp_path / "hotkey.png"
    image_path.write_bytes(b"screenshot")

    def fake_chat(messages, **kwargs):
        captured["messages"] = messages
        captured["tools"] = kwargs.get("tools")
        return _text_response("I will use the attached screenshot."), _metrics(
            "attached-image"
        )

    monkeypatch.setattr(tutor_module, "chat_completion", fake_chat)
    agent = TutorAgent("test-model", "base system")

    response, _ = agent.chat_with_metrics(
        [{"role": "user", "content": "Help with this UI."}],
        image_paths=[str(image_path)],
    )

    assert response == "I will use the attached screenshot."
    system_prompt = captured["messages"][0]["content"]
    assert (
        "treat that image as the screen state the user deliberately chose"
        in system_prompt
    )
    assert "do not call observe_screen" in system_prompt
    tool_names = {tool["function"]["name"] for tool in captured["tools"]}
    assert "observe_screen" in tool_names


def test_chat_memory_tool_loop_keeps_exchange_as_separate_messages(
    monkeypatch,
) -> None:
    responses = iter(
        [
            _tool_response(
                "get_user_context",
                {"query": "roadmap", "limit": 3, "evidence_limit": 1},
            ),
            _text_response("The roadmap review appears to be your current task."),
        ]
    )
    calls: list[list[dict]] = []

    async def fake_memory_mcp(**kwargs):
        return _memory_result()

    def fake_chat(messages, **kwargs):
        calls.append([dict(message) for message in messages])
        return next(responses), _metrics(f"chat-{len(calls)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(tutor_module, "chat_completion", fake_chat)
    monkeypatch.setattr(
        tutor_module,
        "_current_datetime_context",
        lambda: "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
    )
    agent = TutorAgent("test-model", "base system")

    response, metrics = agent.chat_with_metrics(
        [{"role": "user", "content": "What was I working on?"}]
    )

    assert response.startswith("The roadmap")
    assert [message["role"] for message in calls[0]] == ["system", "user"]
    assert "2026-07-23T12:34:56-07:00" in calls[0][0]["content"]
    assert [message["role"] for message in calls[1]] == [
        "system",
        "user",
        "assistant",
        "tool",
    ]
    assert "reviewing a roadmap in Notion" in calls[1][-1]["content"]
    assert metrics["tool_calls"][0]["name"] == "get_user_context"
    assert metrics["tool_calls"][0]["result"]["count"] == 1


def test_chat_streams_answer_and_emits_memory_tool_events(monkeypatch) -> None:
    responses = [
        (
            _tool_response(
                "get_user_context",
                {"query": "roadmap", "limit": 3, "evidence_limit": 1},
            ),
            [],
        ),
        (
            _text_response("The roadmap is the current task."),
            ["The roadmap ", "is the current task."],
        ),
    ]
    call_index = 0

    async def fake_memory_mcp(**kwargs):
        return _memory_result()

    def fake_chat(messages, **kwargs):
        nonlocal call_index
        response, chunks = responses[call_index]
        call_index += 1
        on_chunk = kwargs.get("on_chunk")
        if on_chunk is not None:
            for chunk in chunks:
                on_chunk(chunk)
        return response, _metrics(f"chat-{call_index}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(tutor_module, "chat_completion", fake_chat)
    events: list[dict] = []
    agent = TutorAgent("test-model", "base system")

    response, _ = agent.chat_with_metrics(
        [{"role": "user", "content": "What was I working on?"}],
        on_event=events.append,
    )

    assert response == "The roadmap is the current task."
    assert [event["type"] for event in events] == [
        "tool_call_started",
        "tool_call_completed",
        "text_delta",
        "text_delta",
    ]
    assert (
        "".join(event["text"] for event in events if event["type"] == "text_delta")
        == response
    )
    assert all("tool_call" not in event.get("text", "") for event in events)


def test_chat_allows_more_than_three_tool_calls(monkeypatch) -> None:
    tool_responses = [
        _tool_response(
            "get_user_context",
            {
                "query": f"context {index}",
                "limit": 1,
                "evidence_limit": 0,
            },
            call_id=f"call-{index}",
        )
        for index in range(4)
    ]
    responses = iter(
        [*tool_responses, _text_response("Final answer after four retrievals.")]
    )
    tool_queries: list[str] = []

    async def fake_memory_mcp(**kwargs):
        tool_queries.append(kwargs["query"])
        return {"count": 0, "results": []}

    def fake_chat(messages, **kwargs):
        return next(responses), _metrics(f"chat-{len(tool_queries)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(tutor_module, "chat_completion", fake_chat)
    agent = TutorAgent("test-model", "base system")

    response, metrics = agent.chat_with_metrics(
        [{"role": "user", "content": "Use all relevant context."}]
    )

    assert response == "Final answer after four retrievals."
    assert tool_queries == [f"context {index}" for index in range(4)]
    assert len(metrics["tool_calls"]) == 4
