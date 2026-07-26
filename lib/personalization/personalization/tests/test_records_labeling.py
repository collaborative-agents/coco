import json

import pytest
from personalization.labeling import (
    build_candidate_moments,
    label_records,
    label_signals_for_moment,
    revise_label_disagreements,
)
from personalization.records import flatten_sessions, load_records
from personalization.signals import derive_short_window_signals
from personalization.signals.future_behavior import derive_future_behavior_signals
from personalization.signals.user_feedback import feedback_to_short_window_signal


def _append_jsonl(path, rows):
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")


def test_load_records_and_label_feedback(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    retained_dir = session / "observer_screenshots"
    retained_dir.mkdir()
    retained_image = retained_dir / "obs-1_0.png"
    retained_image.write_bytes(b"fake image bytes")
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-1",
                "session_id": "s1",
                "ts": 1.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "inefficient",
                        "observation": "The user repeats a lookup.",
                        "user_intent": "Find a citation.",
                    }
                ),
                "screenshot_paths": ["/tmp/missing.png"],
                "retained_screenshots": [],
            }
        ],
    )
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": 2.0,
                "session_id": "s1",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": "obs-1",
                "status": "inefficient",
                "text": "Help me automate the lookup.",
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    assert len(records.observations) == 1
    assert records.observations[0].retained_screenshots == [str(retained_image)]

    moments = build_candidate_moments(records)
    assert moments[0].status == "inefficient"
    assert moments[0].retained_image_paths == [str(retained_image)]

    signals = derive_short_window_signals(records)
    assert [(s.kind, s.polarity) for s in signals] == [("engage", "positive")]
    assert feedback_to_short_window_signal(records.feedback[0]).kind == "engage"

    labeled = label_records(records)
    assert len(labeled) == 1
    assert labeled[0].need_support == "yes"
    assert labeled[0].target_suggestion == "Help me automate the lookup."


def test_future_user_prompt_creates_positive_signal(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-1",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt 1",
                "observer_output": json.dumps(
                    {"status": "observing", "observation": "Reading docs."}
                ),
            },
            {
                "observation_id": "obs-2",
                "session_id": "s1",
                "ts": 20.0,
                "type": "user_prompt",
                "model": "fake",
                "observer_input": "prompt 2",
                "observer_output": json.dumps(
                    {"status": "observing", "observation": "User asks ChatGPT."}
                ),
            },
        ],
    )
    _append_jsonl(
        session / "tutor_calls.jsonl",
        [
            {
                "ts": 21.0,
                "session_id": "s1",
                "trigger": "user_prompt",
                "scenario": "everyday_support",
                "model": "fake",
                "tutor_input": "input",
                "tutor_output": "Use this command.",
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    signals = derive_future_behavior_signals(records)
    assert any(
        s.observation_id == "obs-1" and s.kind == "user_prompt_after" for s in signals
    )


def test_search_and_ai_tool_behavior_do_not_create_labels(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-1",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt 1",
                "observer_output": json.dumps(
                    {"status": "observing", "observation": "Reading documentation."}
                ),
            },
            {
                "observation_id": "obs-2",
                "session_id": "s1",
                "ts": 20.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt 2",
                "observer_output": json.dumps(
                    {
                        "status": "observing",
                        "observation": (
                            "The user searched Google and asked ChatGPT about the API."
                        ),
                    }
                ),
            },
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    signals = derive_future_behavior_signals(records)
    obs_1_kinds = {
        signal.kind for signal in signals if signal.observation_id == "obs-1"
    }

    assert {"search_after", "ai_tool_after"} <= obs_1_kinds
    assert label_records(records) == []


def test_judge_and_observer_status_do_not_create_label_signals(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-stuck",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {"status": "stuck", "observation": "User appears stuck."}
                ),
            },
            {
                "observation_id": "obs-progress",
                "session_id": "s1",
                "ts": 20.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {"status": "progress", "observation": "User is progressing."}
                ),
            },
        ],
    )
    _append_jsonl(
        session / "decisions.jsonl",
        [
            {
                "decision_id": "decision-1",
                "session_id": "s1",
                "ts": 11.0,
                "scenario": "everyday_support",
                "phase": "nudge",
                "should_intervene": True,
                "confidence": 1.0,
                "evidence": "The judge recommends intervening.",
                "judge_input": "judge prompt",
                "observer": {
                    "fresh_observation_id": "obs-stuck",
                    "history_observation_ids": [],
                },
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    moments = build_candidate_moments(records)

    assert all(label_signals_for_moment(moment, []) == [] for moment in moments)
    assert label_records(records) == []


def test_disagreement_model_revises_observation_and_intent(tmp_path, monkeypatch):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-false-negative",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "progress",
                        "observation": "Original false-negative observation.",
                        "user_intent": "Original false-negative intent.",
                    }
                ),
            },
            {
                "observation_id": "obs-false-positive",
                "session_id": "s2",
                "ts": 20.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "stuck",
                        "observation": "Original false-positive observation.",
                        "user_intent": "Original false-positive intent.",
                    }
                ),
            },
            {
                "observation_id": "obs-agreement",
                "session_id": "s3",
                "ts": 30.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "stuck",
                        "observation": "Original agreeing observation.",
                        "user_intent": "Original agreeing intent.",
                    }
                ),
            },
        ],
    )
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": 11.0,
                "session_id": "s1",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": "obs-false-negative",
            },
            {
                "ts": 21.0,
                "session_id": "s2",
                "kind": "dismiss",
                "surface": "bubble",
                "observation_id": "obs-false-positive",
            },
            {
                "ts": 31.0,
                "session_id": "s3",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": "obs-agreement",
            },
        ],
    )

    calls = []

    def fake_prompt_to_text(*, model, system_prompt, user_prompt):
        calls.append((model, system_prompt, user_prompt))
        polarity = "yes" if "Derived need_support label: yes" in user_prompt else "no"
        return json.dumps(
            {
                "observation": f"Revised {polarity} observation.",
                "user_intent": f"Revised {polarity} intent.",
            }
        )

    monkeypatch.setattr(
        "personalization.labeling.prompt_to_text",
        fake_prompt_to_text,
    )

    records = flatten_sessions(load_records(tmp_path))
    labeled = label_records(records)
    revised, eligible = revise_label_disagreements(
        records,
        labeled,
        model="fake/revision-model",
        limit=2,
        concurrency=2,
    )
    by_id = {moment.observation_id: moment for moment in revised}

    assert eligible == 2
    assert len(revised) == 2
    assert len(calls) == 2
    assert {call[0] for call in calls} == {"fake/revision-model"}
    assert all(
        "screenshot-derived observation" in system_prompt
        and "long-term user memory" in system_prompt
        for _, system_prompt, _ in calls
    )
    assert by_id["obs-false-negative"].target_observation == "Revised yes observation."
    assert by_id["obs-false-negative"].target_user_intent == "Revised yes intent."
    assert by_id["obs-false-positive"].target_observation == "Revised no observation."
    assert by_id["obs-false-positive"].target_user_intent == "Revised no intent."

    original_by_id = {moment.observation_id: moment for moment in labeled}
    assert (
        original_by_id["obs-false-negative"].target_observation
        == "Original false-negative observation."
    )
    assert (
        original_by_id["obs-agreement"].target_observation
        == "Original agreeing observation."
    )


def test_disagreement_revision_limit_bounds_llm_calls(tmp_path, monkeypatch):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": f"obs-{index}",
                "session_id": f"s{index}",
                "ts": float(index),
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "progress",
                        "observation": f"Original observation {index}.",
                        "user_intent": f"Original intent {index}.",
                    }
                ),
            }
            for index in range(1, 4)
        ],
    )
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": float(index) + 0.1,
                "session_id": f"s{index}",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": f"obs-{index}",
            }
            for index in range(1, 4)
        ],
    )

    calls = []

    def fake_prompt_to_text(*, model, system_prompt, user_prompt):
        calls.append(user_prompt)
        return json.dumps(
            {
                "observation": "Revised observation.",
                "user_intent": "Revised intent.",
            }
        )

    monkeypatch.setattr(
        "personalization.labeling.prompt_to_text",
        fake_prompt_to_text,
    )

    progress_updates = []

    class FakeProgress:
        def __init__(self, *, total, **kwargs):
            progress_updates.append(("total", total))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def update(self):
            progress_updates.append(("update", 1))

    monkeypatch.setattr("personalization.labeling.tqdm", FakeProgress)

    records = flatten_sessions(load_records(tmp_path))
    revised, eligible = revise_label_disagreements(
        records,
        label_records(records),
        model="fake/revision-model",
        limit=1,
        show_progress=True,
    )

    assert eligible == 3
    assert len(revised) == 1
    assert len(calls) == 1
    assert progress_updates == [("total", 1), ("update", 1)]


def test_disagreement_revision_without_limit_revises_all(tmp_path, monkeypatch):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": f"obs-{index}",
                "session_id": f"s{index}",
                "ts": float(index),
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "progress",
                        "observation": f"Original observation {index}.",
                        "user_intent": f"Original intent {index}.",
                    }
                ),
            }
            for index in range(1, 4)
        ],
    )
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": float(index) + 0.1,
                "session_id": f"s{index}",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": f"obs-{index}",
            }
            for index in range(1, 4)
        ],
    )

    calls = []

    def fake_prompt_to_text(*, model, system_prompt, user_prompt):
        calls.append(user_prompt)
        return json.dumps(
            {
                "observation": "Revised observation.",
                "user_intent": "Revised intent.",
            }
        )

    monkeypatch.setattr(
        "personalization.labeling.prompt_to_text",
        fake_prompt_to_text,
    )

    records = flatten_sessions(load_records(tmp_path))
    revised, eligible = revise_label_disagreements(
        records,
        label_records(records),
        model="fake/revision-model",
    )

    assert eligible == 3
    assert len(revised) == 3
    assert len(calls) == 3


def _write_single_disagreement(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-retry",
                "session_id": "s1",
                "ts": 1.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps(
                    {
                        "status": "progress",
                        "observation": "Original observation.",
                        "user_intent": "Original intent.",
                    }
                ),
            }
        ],
    )
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": 1.1,
                "session_id": "s1",
                "kind": "engage",
                "surface": "bubble",
                "observation_id": "obs-retry",
            }
        ],
    )
    return flatten_sessions(load_records(tmp_path))


def test_disagreement_revision_retries_invalid_responses(tmp_path, monkeypatch):
    responses = iter(
        [
            "not json",
            json.dumps({"observation": "Missing intent."}),
            json.dumps(
                {
                    "observation": "Revised observation.",
                    "user_intent": "Revised intent.",
                }
            ),
        ]
    )
    prompts = []

    def fake_prompt_to_text(*, model, system_prompt, user_prompt):
        prompts.append(user_prompt)
        return next(responses)

    monkeypatch.setattr(
        "personalization.labeling.prompt_to_text",
        fake_prompt_to_text,
    )

    records = _write_single_disagreement(tmp_path)
    revised, eligible = revise_label_disagreements(
        records,
        label_records(records),
        model="fake/revision-model",
        retries=2,
    )

    assert eligible == 1
    assert revised[0].target_observation == "Revised observation."
    assert revised[0].target_user_intent == "Revised intent."
    assert len(prompts) == 3
    assert "Your previous response was invalid" in prompts[1]
    assert "not json" in prompts[1]
    assert "Missing intent." in prompts[2]


def test_disagreement_revision_raises_after_retries(tmp_path, monkeypatch):
    calls = []

    def fake_prompt_to_text(*, model, system_prompt, user_prompt):
        calls.append(user_prompt)
        return "still not json"

    monkeypatch.setattr(
        "personalization.labeling.prompt_to_text",
        fake_prompt_to_text,
    )

    records = _write_single_disagreement(tmp_path)
    with pytest.raises(ValueError, match="invalid JSON after 2 attempts"):
        revise_label_disagreements(
            records,
            label_records(records),
            model="fake/revision-model",
            retries=1,
        )

    assert len(calls) == 2
