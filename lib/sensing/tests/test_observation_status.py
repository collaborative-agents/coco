import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sensing import segment_processor
from sensing.segment_processor import _classify_observation_status


def _broadcast_test_processor():
    processor = object.__new__(segment_processor.AiTutoringProcessor)
    processor._obs_subscribers = [asyncio.Queue()]
    processor._scenario = "ai_upskilling"
    processor._session_active = True
    processor._last_suggestion_ts = 0.0
    return processor


def test_human_mistake_maps_to_mistake_status():
    observation = json.dumps(
        {
            "mistake_made_by_human": "The visible word 'teh' is a typo.",
            "inefficiency_patterns": "no delegation opportunity",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "mistake"


def test_no_human_mistake_is_neutral():
    observation = json.dumps(
        {
            "mistake_made_by_human": "no human mistake detected",
            "inefficiency_patterns": "no delegation opportunity",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "progress"


def test_judge_intervention_is_marked_for_desktop_filtering():
    processor = _broadcast_test_processor()

    processor._broadcast_observation(
        "struggle",
        "The Judge found repeated friction.",
        intervention_source="judge",
    )

    event = processor._obs_subscribers[0].get_nowait()
    assert event["status"] == "stuck"
    assert event["intervention_source"] == "judge"


def test_ambient_observation_is_not_marked_as_judge_approved():
    processor = _broadcast_test_processor()
    observation = json.dumps(
        {
            "status": "stuck",
            "user_intent": "Editing a spreadsheet",
        }
    )

    processor._broadcast_observation("snapshot", observation)

    event = processor._obs_subscribers[0].get_nowait()
    assert event["status"] == "stuck"
    assert "intervention_source" not in event


def test_pre_session_observer_emits_task_suggestion():
    processor = _broadcast_test_processor()
    processor._session_active = False
    observation = json.dumps(
        {
            "status": "progress",
            "user_intent": "reviewing payroll data",
        }
    )

    processor._broadcast_observation("snapshot", observation)

    event = processor._obs_subscribers[0].get_nowait()
    assert event["status"] == "task_suggested"
    assert event["task_label"] == "reviewing payroll data"
    assert "intervention_source" not in event


@pytest.mark.asyncio
async def test_ai_upskilling_observer_context_keeps_current_task_and_memory():
    processor = _broadcast_test_processor()
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: {
            "problem_statement": "Review the payroll spreadsheet",
            "memory": "The user prefers concise instructions.",
            "conversation_history": ["[User]: Help me review this"],
        },
    )
    processor._http_client = SimpleNamespace(
        get=AsyncMock(return_value=response),
    )
    processor.tutor_url = "http://tutor.test"

    context = await processor._build_context_prompt()

    assert "<problem_statement>\nReview the payroll spreadsheet" in context
    assert "<memory>\nThe user prefers concise instructions." in context
    assert "[User]: Help me review this" in context


def test_openai_compatible_observer_does_not_inject_provider_options(monkeypatch):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model="hosted_vllm/Qwen/Qwen3.5-35B-A3B",
    )

    assert "extra_body" not in captured
    assert "reasoning_effort" not in captured


def test_inkling_observer_disables_reasoning_effort(monkeypatch):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model="hosted_vllm/thinkingmachines/Inkling-Small:peft:262144",
    )

    assert captured["reasoning_effort"] == "none"
    assert "extra_body" not in captured
