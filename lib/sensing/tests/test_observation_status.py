import json
from types import SimpleNamespace

import pytest
from sensing import segment_processor
from sensing.segment_processor import _classify_observation_status


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


@pytest.mark.parametrize(
    "model",
    [
        "hosted_vllm/Qwen/Qwen3.5-9B",
        "hosted_vllm/Qwen/Qwen3.5-35B-A3B",
        "hosted_vllm/custom-checkpoint",
    ],
)
def test_openai_compatible_observer_disables_thinking(monkeypatch, model):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model=model,
    )

    assert captured["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }
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


def test_custom_observer_preserves_reporting_contract(monkeypatch, tmp_path):
    monkeypatch.setenv("COCO_USER_DATA_DIR", str(tmp_path))
    custom = "Look for writing mistakes. Respond in plain text."
    effective = segment_processor._install_custom_observer_prompt(custom)

    # Only user instructions are persisted; the current contract is attached
    # each time, including when an older saved prompt is reloaded.
    assert segment_processor._custom_observer_prompt_path().read_text() == custom
    assert effective.startswith(custom)
    schema = json.loads(effective.split("Output in JSON format:", 1)[1])
    assert set(schema) == {
        "current_task",
        "task_continuity",
        "repeats_dismissed_support",
        "observation",
        "user_intent",
        "inefficiency_patterns",
        "mistake_made_by_human",
        "task_complete",
        "applying_ai_output",
        "status",
    }
    assert "always applies" in effective
    assert "single JSON object" in effective
    assert segment_processor._install_custom_observer_prompt(custom) == effective


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scenario,raw,expected_status,should_notify",
    [
        (
            "everyday_support",
            '{"status": "progress", "user_intent": "Watching a podcast"}',
            "progress",
            False,
        ),
        ("everyday_support", '{"status": "observing"}', "observing", False),
        ("everyday_support", "not json", "observing", False),
        ("everyday_support", '{"status": "stuck"}', "stuck", True),
        ("everyday_support", '{"status": "mistake"}', "mistake", True),
        ("everyday_support", '{"status": "inefficient"}', "inefficient", True),
        (
            "student_learning",
            '{"stuck": "not stuck", "mistakes": "no mistake so far"}',
            "progress",
            False,
        ),
        (
            "student_learning",
            '{"stuck": "Repeated failed attempts at the same equation"}',
            "stuck",
            True,
        ),
    ],
)
async def test_pause_assessment_controls_both_ui_and_tutor(
    monkeypatch, tmp_path, scenario, raw, expected_status, should_notify
):
    from unittest.mock import AsyncMock

    processor = segment_processor.AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log=str(tmp_path / "observations.log"),
        observer_model="test",
        scenario=scenario,
    )
    processor._build_context_prompt = AsyncMock(return_value="")
    processor._collect_images = lambda text: (text, [])
    prompts = []

    def observe(text, *_args, **_kwargs):
        prompts.append(text)
        return raw, {}

    monkeypatch.setattr(segment_processor, "_observe", observe)
    observations = processor.subscribe_observations()
    tutor_events = processor.subscribe_pause()

    await processor.process(type="pause")

    assert len(prompts) == 1  # Pausing still triggers an assessment.
    assert "<activity_check" in prompts[0]
    assert "<user_input" not in prompts[0]
    assert observations.get_nowait()["status"] == expected_status
    assert tutor_events.empty() is (not should_notify)
    if should_notify:
        assert tutor_events.get_nowait()["data"]["observation"] == raw
