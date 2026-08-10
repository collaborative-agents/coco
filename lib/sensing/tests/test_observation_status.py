import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sensing import segment_processor
from sensing.segment_processor import (
    AiTutoringProcessor,
    _classify_observation_status,
    _extract_need_support,
)


def test_need_support_yes_maps_to_actionable_status():
    observation = json.dumps(
        {
            "observation": "The user is repeatedly copying values between apps.",
            "user_intent": "Transfer evaluation results",
            "need_support": "yes",
            "rationale": "Automating the repeated transfer would save time.",
        }
    )

    assert (
        _classify_observation_status("everyday_support", observation)
        == "support_needed"
    )


def test_need_support_no_maps_to_neutral_status():
    observation = json.dumps(
        {
            "observation": "The user opened a document and is reading it.",
            "user_intent": "Review the document",
            "need_support": "no",
            "rationale": "The user is progressing normally.",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "observing"


def test_need_support_accepts_json_booleans():
    assert _extract_need_support('{"need_support": true}') == "yes"
    assert _extract_need_support('{"need_support": false}') == "no"


def test_broadcast_surfaces_support_decision_and_rationale():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    queue = processor.subscribe_observations()
    observation = json.dumps(
        {
            "observation": "The user is blocked by a recurring error.",
            "user_intent": "Fix the build",
            "need_support": "yes",
            "rationale": "The same build error has persisted across frames.",
        }
    )

    processor._broadcast_observation("snapshot", observation)

    event = queue.get_nowait()
    assert event["status"] == "support_needed"
    assert event["need_support"] == "yes"
    assert event["rationale"] == "The same build error has persisted across frames."


def test_pause_broadcast_uses_explicit_support_status():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    queue = processor.subscribe_observations()

    processor._broadcast_observation(
        "pause",
        '{"need_support":"no","rationale":"Brief idle time is not a blocker."}',
    )

    event = queue.get_nowait()
    assert event["status"] == "observing"
    assert event["need_support"] == "no"


@pytest.mark.asyncio
async def test_pause_no_support_suppresses_proactive_tutor_event():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    processor._handle_observation = AsyncMock(
        return_value=(
            '{"need_support":"no","rationale":"The user is only briefly idle."}',
            "observer input",
            {},
        )
    )
    processor.broadcast_pause = MagicMock()

    await processor._handle_pause(image_path=None, timestamp=None)

    processor.broadcast_pause.assert_not_called()


@pytest.mark.asyncio
async def test_pause_yes_support_reaches_proactive_tutor():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    processor._handle_observation = AsyncMock(
        return_value=(
            '{"need_support":"yes","rationale":"A persistent error is visible."}',
            "observer input",
            {},
        )
    )
    processor.broadcast_pause = MagicMock()

    await processor._handle_pause(image_path=None, timestamp=None)

    processor.broadcast_pause.assert_called_once()


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
