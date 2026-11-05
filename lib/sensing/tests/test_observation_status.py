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
