import json

from personalization.labeling import (
    build_candidate_moments,
    label_records,
    label_signals_for_moment,
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
