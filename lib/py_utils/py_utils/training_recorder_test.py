"""Test the TrainingRecorder class.

```
uv run pytest lib/py_utils/py_utils/training_recorder_test.py
```
"""

import json

from py_utils.training_recorder import TrainingRecorder


def test_training_recorder_writes_llm_metrics(tmp_path):
    metrics = {
        "call_id": "call-test",
        "operation": "observer",
        "model": "fake-model",
        "provider": "fake",
        "modality": "vlm",
        "prompt_tokens": 21,
        "completion_tokens": 8,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "input_tokens": 21,
        "output_tokens": 8,
        "total_tokens": 29,
        "duration_ms": 123.4,
        "started_at": 1000.0,
        "ended_at": 1000.1234,
        "success": True,
        "error": None,
    }
    recorder = TrainingRecorder(str(tmp_path), retain_screenshots=False)

    recorder.log_observation(
        observation_id="obs-1",
        ts=1.0,
        obs_type="snapshot",
        observer_input="input",
        observer_output="output",
        model="fake-model",
        screenshot_paths=[],
        llm_metrics=metrics,
    )
    recorder.log_tutor(
        ts=2.0,
        session_id="session-1",
        trigger="user_prompt",
        scenario="everyday_support",
        model="fake-model",
        tutor_input="prompt",
        tutor_output="guidance",
        llm_metrics=metrics,
    )

    observation_rows = [
        json.loads(line)
        for line in (tmp_path / "observations.jsonl").read_text().splitlines()
    ]
    tutor_rows = [
        json.loads(line)
        for line in (tmp_path / "tutor_calls.jsonl").read_text().splitlines()
    ]
    assert observation_rows[0]["llm_metrics"] == metrics
    assert tutor_rows[0]["llm_metrics"] == metrics
