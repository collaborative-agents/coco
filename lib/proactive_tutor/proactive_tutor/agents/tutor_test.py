from __future__ import annotations

from external_api.litellm_api import LiteLLMMessage, TextContent
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


def test_tool_rejects_non_mcp_tool_and_unexpected_arguments() -> None:
    agent = TutorAgent("test-model", "system")

    wrong_tool = agent._execute_tool_call({"name": "unknown_tool", "arguments": {}})
    wrong_argument = agent._execute_tool_call(
        {"name": "get_user_context", "arguments": {"path": "/tmp"}}
    )

    assert "only get_user_context and get_recent_observations" in wrong_tool["error"]
    assert "unexpected arguments: path" in wrong_argument["error"]


def test_tutor_executes_memory_mcp_and_synthesizes_answer(monkeypatch) -> None:
    responses = iter(
        [
            '<tool_call>{"name":"get_user_context","arguments":{"query":"roadmap","limit":3,"evidence_limit":1}}</tool_call>',
            "<guidance>The roadmap review appears to be your current task.</guidance>",
        ]
    )
    prompts: list[tuple[str, str]] = []

    async def fake_memory_mcp(**kwargs):
        assert kwargs["query"] == "roadmap"
        return _memory_result()

    def fake_completion(model, system_prompt, user_prompt, **kwargs):
        prompts.append((system_prompt, user_prompt))
        return next(responses), _metrics(f"call-{len(prompts)}")

    monkeypatch.setattr(tutor_module, "call_get_user_context", fake_memory_mcp)
    monkeypatch.setattr(tutor_module, "prompt_to_text_with_metrics", fake_completion)
    monkeypatch.setattr(
        tutor_module,
        "_current_datetime_context",
        lambda: "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
    )
    agent = TutorAgent("test-model", "base system")

    response, metrics = agent.tutor_with_metrics("current context")

    assert response.startswith("<guidance>The roadmap")
    assert "get_user_context" in prompts[0][0]
    assert "2026-07-23T12:34:56-07:00" in prompts[0][0]
    assert "reviewing a roadmap in Notion" in prompts[1][1]
    assert metrics["total_tokens"] == 10


def test_tutor_skips_tool_loop_when_disabled(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    def fake_completion(model, system_prompt, user_prompt, **kwargs):
        calls.append((system_prompt, user_prompt))
        return "final guidance", _metrics("single-call")

    monkeypatch.setattr(tutor_module, "prompt_to_text_with_metrics", fake_completion)
    monkeypatch.setattr(
        tutor_module,
        "_current_datetime_context",
        lambda: "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
    )
    agent = TutorAgent("test-model", "base system", enable_memory_tool=False)

    response, metrics = agent.tutor_with_metrics("context")

    assert response == "final guidance"
    assert calls == [
        (
            "base system\n\n"
            "<current_datetime>2026-07-23T12:34:56-07:00</current_datetime>",
            "context",
        )
    ]
    assert metrics["call_id"] == "single-call"


def test_chat_memory_tool_loop_keeps_exchange_as_separate_messages(
    monkeypatch,
) -> None:
    responses = iter(
        [
            '<tool_call>{"name":"get_user_context","arguments":{"query":"roadmap","limit":3,"evidence_limit":1}}</tool_call>',
            "The roadmap review appears to be your current task.",
        ]
    )
    calls: list[list[dict]] = []

    async def fake_memory_mcp(**kwargs):
        return _memory_result()

    def fake_chat(messages, **kwargs):
        calls.append([dict(message) for message in messages])
        return (
            LiteLLMMessage(
                role="assistant", content=[TextContent(text=next(responses))]
            ),
            _metrics(f"chat-{len(calls)}"),
        )

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
    assert [message["role"] for message in calls[0]] == [
        "system",
        "system",
        "user",
    ]
    assert "2026-07-23T12:34:56-07:00" in calls[0][1]["content"]
    assert [message["role"] for message in calls[1]] == [
        "system",
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert "reviewing a roadmap in Notion" in calls[1][-1]["content"]
    assert metrics["tool_calls"][0]["name"] == "get_user_context"
    assert metrics["tool_calls"][0]["result"]["count"] == 1


def test_chat_streams_answer_and_emits_memory_tool_events(monkeypatch) -> None:
    responses = [
        [
            "<tool",
            '_call>{"name":"get_user_context","arguments":',
            '{"query":"roadmap","limit":3,"evidence_limit":1}}</tool_call>',
        ],
        ["The roadmap ", "is the current task."],
    ]
    call_index = 0

    async def fake_memory_mcp(**kwargs):
        return _memory_result()

    def fake_chat(messages, **kwargs):
        nonlocal call_index
        chunks = responses[call_index]
        call_index += 1
        on_chunk = kwargs.get("on_chunk")
        if on_chunk is not None:
            for chunk in chunks:
                on_chunk(chunk)
        return (
            LiteLLMMessage(
                role="assistant", content=[TextContent(text="".join(chunks))]
            ),
            _metrics(f"chat-{call_index}"),
        )

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
    assert all("<tool_call>" not in str(event) for event in events)
