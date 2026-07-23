import json
from types import SimpleNamespace

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


def test_vllm_observer_disables_thinking(monkeypatch):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model="hosted_vllm/Qwen/Qwen3.5-35B-A3B",
    )

    assert captured["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }
