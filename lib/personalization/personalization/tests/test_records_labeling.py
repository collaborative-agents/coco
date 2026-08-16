import json

import personalization.signals.retrospective as retrospective
import pytest
from personalization.labeling import (
    build_candidate_moments,
    label_records,
    label_signals_for_moment,
    revise_label_disagreements,
)
from personalization.records import flatten_sessions, load_records
from personalization.signals import derive_short_window_signals
from personalization.signals.missed_opportunities import (
    derive_missed_opportunity_signals,
)
from personalization.signals.user_feedback import (
    FEEDBACK_POLICIES,
    feedback_to_short_window_signal,
)


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
    label_signals = label_signals_for_moment(moments[0], signals)
    assert label_signals[0].weight == FEEDBACK_POLICIES["engage"].label_weight
    assert label_signals[0].confidence == FEEDBACK_POLICIES["engage"].confidence

    labeled = label_records(records)
    assert len(labeled) == 1
    assert labeled[0].need_support == "yes"
    assert labeled[0].label_sources == ["feedback:engage"]
    assert labeled[0].target_suggestion == "Help me automate the lookup."
    image_required = label_records(records, require_saved_images=True)
    assert len(image_required) == 1
    assert image_required[0].image_paths == [str(retained_image)]


def test_latest_thumbs_rating_replaces_accidental_label(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "feedback.jsonl",
        [
            {
                "ts": 1.0,
                "session_id": "s1",
                "kind": "thumbs_down",
                "surface": "notification",
                "observation_id": "obs-1",
            },
            {
                "ts": 2.0,
                "session_id": "s1",
                "kind": "thumbs_up",
                "surface": "history",
                "observation_id": "obs-1",
                "extra": {"replaces_kind": "thumbs_down"},
            },
            {
                "ts": 3.0,
                "session_id": "s1",
                "kind": "thumbs_up",
                "surface": "chat",
                "message_id": "message-1",
            },
            {
                "ts": 4.0,
                "session_id": "s1",
                "kind": "thumbs_down",
                "surface": "chat",
                "message_id": "message-1",
                "extra": {"replaces_kind": "thumbs_up"},
            },
        ],
    )

    records = flatten_sessions(load_records(tmp_path))

    assert [
        (event.kind, event.observation_id, event.message_id)
        for event in records.feedback
    ] == [
        ("thumbs_up", "obs-1", None),
        ("thumbs_down", None, "message-1"),
    ]


def test_manual_user_prompt_creates_missed_opportunity_signal(tmp_path):
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
    signals = derive_missed_opportunity_signals(records)
    assert any(
        s.observation_id == "obs-1" and s.kind == "user_prompt_after" for s in signals
    )


def test_legacy_null_session_user_prompt_uses_request_start_time(tmp_path):
    session = tmp_path / "session_legacy"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-before-prompt",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt 1",
                "observer_output": json.dumps(
                    {"status": "observing", "observation": "Editing a document."}
                ),
            },
            {
                "observation_id": "obs-user-prompt",
                "session_id": "s1",
                # Observer persistence can finish after the tutor request starts.
                "ts": 30.0,
                "type": "user_prompt",
                "model": "fake",
                "observer_input": "prompt 2",
                "observer_output": json.dumps(
                    {"status": "observing", "observation": "Asking for help."}
                ),
            },
        ],
    )
    _append_jsonl(
        session / "tutor_calls.jsonl",
        [
            {
                # Legacy rows were timestamped after generation and had no session.
                "ts": 121.0,
                "session_id": None,
                "trigger": "user_prompt",
                "scenario": "everyday_support",
                "model": "fake",
                "tutor_input": "input",
                "tutor_output": "output",
                "llm_metrics": {"started_at": 21.0},
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))

    assert records.tutor_calls[0].session_id == "s1"
    assert records.tutor_calls[0].event_ts == 21.0
    prompted_observations = {
        signal.observation_id
        for signal in derive_missed_opportunity_signals(records)
        if signal.kind == "user_prompt_after"
    }
    assert prompted_observations == {"obs-before-prompt"}

    labels = label_records(records)
    assert {label.observation_id for label in labels} == prompted_observations
    assert all(label.need_support == "yes" for label in labels)
    assert all(label.label_sources == ["user_prompt_after"] for label in labels)


def test_tutor_output_is_not_attributed_across_sessions(tmp_path):
    session = tmp_path / "session_mixed"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "obs-s1",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": "{}",
            },
            {
                "observation_id": "obs-s2",
                "session_id": "s2",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": "{}",
            },
        ],
    )
    _append_jsonl(
        session / "tutor_calls.jsonl",
        [
            {
                "ts": 20.0,
                "session_id": "s1",
                "trigger": "user_prompt",
                "scenario": "everyday_support",
                "model": "fake",
                "tutor_input": "input",
                "tutor_output": "Only for s1",
            }
        ],
    )

    moments = build_candidate_moments(flatten_sessions(load_records(tmp_path)))
    calls_by_observation = {
        moment.observation_id: [call.tutor_output for call in moment.tutor_calls_after]
        for moment in moments
    }
    assert calls_by_observation == {
        "obs-s1": ["Only for s1"],
        "obs-s2": [],
    }


def test_user_prompt_after_default_window_is_one_minute(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "at-boundary",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "no"}),
            },
            {
                "observation_id": "outside-boundary",
                "session_id": "s1",
                "ts": 9.999,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "no"}),
            },
        ],
    )
    _append_jsonl(
        session / "tutor_calls.jsonl",
        [
            {
                "ts": 70.0,
                "session_id": "s1",
                "trigger": "user_prompt",
                "scenario": "everyday_support",
                "model": "fake",
                "tutor_input": "input",
                "tutor_output": "output",
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    prompted_observations = {
        signal.observation_id
        for signal in derive_missed_opportunity_signals(records)
        if signal.kind == "user_prompt_after"
    }

    assert "at-boundary" in prompted_observations
    assert "outside-boundary" not in prompted_observations


def test_search_and_ai_tool_behavior_is_ignored(tmp_path):
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
    signals = derive_missed_opportunity_signals(records)
    assert signals == []
    assert label_records(records) == []


def test_large_context_retrospective_discovers_and_grounds_workflow(
    tmp_path, monkeypatch
):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": f"obs-{index}",
                "session_id": "s1",
                "ts": float(index * 180),
                "type": "snapshot",
                "model": "fake",
                "observer_input": f"attempt {index}",
                "observer_output": json.dumps(
                    {
                        "need_support": "no",
                        "observation": f"The same command failed on attempt {index}.",
                    }
                ),
            }
            for index in range(1, 5)
        ],
    )
    records = flatten_sessions(load_records(tmp_path))

    opportunity = {
        "category": "stuck",
        "workflow_pattern": "Repeated manual run-debug-relaunch cycles.",
        "evidence_observation_ids": ["obs-2", "obs-3", "obs-4"],
        "evidence_summary": "Three observations show the workflow continuing.",
        "when_to_offer": "If the user starts another manual experiment cycle.",
        "support_strategy": "Offer an agent to run and monitor the experiments.",
        "why_high_value": "It saves repeated launch and monitoring work.",
        "why_not_incident_specific": "It applies to future experiment cycles.",
    }
    curated = {
        "opportunity_id": "chunk-1-opportunity-0",
        "accepted": True,
        "decision_rationale": "The repeated workflow is supported and actionable.",
        "workflow_level_opportunity": True,
        "incident_specific": False,
        "category": "stuck",
        "confidence": 0.9,
        **{
            key: opportunity[key]
            for key in (
                "workflow_pattern",
                "evidence_observation_ids",
                "evidence_summary",
                "when_to_offer",
                "support_strategy",
                "why_high_value",
            )
        },
    }

    calls = []
    discovered_opportunities = [opportunity]
    curation_decisions = [curated]
    trigger_decisions = [
        {
            "opportunity_id": "chunk-1-opportunity-0",
            "accepted": True,
            "decision_rationale": "The need was inferable before later evidence.",
            "trigger_observation_id": "obs-1",
            "rationale": (
                "Repeated failures indicate that proactive workflow support "
                "would prevent another manual debug-and-relaunch cycle."
            ),
            "confidence": 0.85,
        }
    ]

    def fake_completion(**kwargs):
        calls.append(kwargs)
        if kwargs["system_prompt"] == retrospective.DISCOVERY_SYSTEM_PROMPT:
            return json.dumps({"support_opportunities": discovered_opportunities})
        if (
            kwargs["system_prompt"]
            == retrospective._EVIDENCE_VERIFICATION_SYSTEM_PROMPT
        ):
            return json.dumps({"opportunity_decisions": curation_decisions})
        return json.dumps({"trigger_decisions": trigger_decisions})

    monkeypatch.setattr(
        retrospective,
        "_complete",
        fake_completion,
    )

    trace_out = tmp_path / "retrospective_trace.jsonl"
    signals = retrospective.derive_retrospective_signals(
        records,
        model="fake/model",
        max_observations=4,
        trace_out=trace_out,
    )

    assert len(calls) == 3
    assert len(signals) == 1
    assert signals[0].observation_id == "obs-1"
    assert signals[0].kind == "retrospective:stuck"
    labels = label_records(records, additional_signals=signals)
    assert len(labels) == 1
    assert labels[0].need_support == "yes"
    assert labels[0].label_sources == ["retrospective:stuck"]
    assert labels[0].target_user_intent is None
    assert labels[0].label_rationale == (
        "Repeated failures indicate that proactive workflow support would "
        "prevent another manual debug-and-relaunch cycle."
    )
    trace = json.loads(trace_out.read_text())
    assert trace["strategy"] == "large_context_chunks"
    assert trace["status"] == "complete"
    assert trace["provided_observation_count"] == 4
    assert trace["parsed_output"]["support_opportunities"][0]["category"] == "stuck"
    assert trace["accepted_signals"][0]["kind"] == "retrospective:stuck"
    assert trace["curation_reviews"][0]["decision_rationale"]
    assert trace["trigger_reviews"][0]["decision_rationale"]
    discovery_input = json.loads(calls[0]["user_prompt"])
    assert all(
        "candidate_no_intervention" not in row for row in discovery_input["timeline"]
    )
    verification_input = json.loads(calls[1]["user_prompt"])
    assert (
        len(verification_input["proposed_opportunities"][0]["evidence_observations"])
        == 3
    )
    assert all(
        "candidate_no_intervention" not in row
        for row in verification_input["proposed_opportunities"][0][
            "evidence_observations"
        ]
    )
    trigger_input = json.loads(calls[2]["user_prompt"])
    assert len(trigger_input["timeline"]) == 4
    assert all("candidate_no_intervention" in row for row in trigger_input["timeline"])
    assert trigger_input["verified_opportunities"][0]["evidence_observation_ids"] == [
        "obs-2",
        "obs-3",
        "obs-4",
    ]

    revised_rationale = trigger_decisions[0].pop("rationale")
    assert (
        retrospective.derive_retrospective_signals(
            records,
            model="fake/model",
            max_observations=4,
        )
        == []
    )
    trigger_decisions[0]["rationale"] = revised_rationale

    second_opportunity = {
        **opportunity,
        "workflow_pattern": "Repeated manual result-copying cycles.",
    }
    discovered_opportunities.append(second_opportunity)
    curation_decisions.append(
        {
            "opportunity_id": "chunk-1-opportunity-1",
            "accepted": False,
            "decision_rationale": (
                "The observations are adjacent and do not establish recurrence."
            ),
        }
    )
    signals = retrospective.derive_retrospective_signals(
        records,
        model="fake/model",
        max_observations=4,
        trace_out=trace_out,
    )
    assert len(signals) == 1
    trace = json.loads(trace_out.read_text())
    rejected = trace["curation_reviews"][1]
    assert rejected["accepted"] is False
    assert "do not establish recurrence" in rejected["decision_rationale"]

    curation_decisions.pop()
    assert (
        retrospective.derive_retrospective_signals(
            records,
            model="fake/model",
            max_observations=4,
            trace_out=trace_out,
        )
        == []
    )
    trace = json.loads(trace_out.read_text())
    omitted = next(
        review
        for review in trace["curation_reviews"]
        if review["opportunity_id"] == "chunk-1-opportunity-1"
    )
    assert omitted["reasons"] == ["evidence verification omitted this opportunity"]
    discovered_opportunities.pop()

    curated["incident_specific"] = True
    assert (
        retrospective.derive_retrospective_signals(
            records,
            model="fake/model",
            max_observations=4,
        )
        == []
    )

    curated["incident_specific"] = False
    curated["evidence_observation_ids"] = ["obs-2", "obs-3"]
    assert (
        retrospective.derive_retrospective_signals(
            records,
            model="fake/model",
            max_observations=4,
        )
        == []
    )

    curated["evidence_observation_ids"] = ["obs-2", "obs-3", "obs-4"]
    curated["category"] = "anticipate_need"
    signals = retrospective.derive_retrospective_signals(
        records,
        model="fake/model",
        max_observations=4,
    )
    assert len(signals) == 1
    assert signals[0].kind == "retrospective:anticipate_need"


def test_large_context_retrospective_combines_recording_sessions(tmp_path, monkeypatch):
    for index in range(3):
        session = tmp_path / f"session_{index}"
        session.mkdir()
        _append_jsonl(
            session / "observations.jsonl",
            [
                {
                    "observation_id": f"obs-{index}",
                    "session_id": None,
                    "ts": float(index),
                    "type": "snapshot",
                    "model": "fake",
                    "observer_input": "attempt",
                    "observer_output": json.dumps({"need_support": "no"}),
                }
            ],
        )

    prompts = []

    def fake_completion(**kwargs):
        prompts.append(json.loads(kwargs["user_prompt"]))
        return json.dumps({"support_opportunities": []})

    monkeypatch.setattr(retrospective, "_complete", fake_completion)

    assert (
        retrospective.derive_retrospective_signals(
            load_records(tmp_path),
            model="fake/model",
        )
        == []
    )
    assert len(prompts) == 1
    assert len(prompts[0]["timeline"]) == 3


def test_retrospective_max_observations_chunks_without_downsampling(
    tmp_path, monkeypatch
):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": f"obs-{index}",
                "session_id": "s1",
                "ts": float(index),
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "no"}),
            }
            for index in range(7)
        ],
    )
    prompts = []

    def fake_completion(**kwargs):
        prompts.append(json.loads(kwargs["user_prompt"]))
        return json.dumps({"support_opportunities": []})

    monkeypatch.setattr(retrospective, "_complete", fake_completion)
    trace_out = tmp_path / "retrospective_chunks.jsonl"
    signals = retrospective.derive_retrospective_signals(
        load_records(tmp_path),
        model="fake/model",
        max_observations=3,
        trace_out=trace_out,
    )

    assert signals == []
    assert [len(prompt["timeline"]) for prompt in prompts] == [3, 3, 3]
    processed_ids = {
        row["observation_id"] for prompt in prompts for row in prompt["timeline"]
    }
    assert processed_ids == {f"obs-{index}" for index in range(7)}
    assert all(prompt["chunk_count"] == 3 for prompt in prompts)
    trace_rows = [json.loads(line) for line in trace_out.read_text().splitlines()]
    assert [row["chunk_index"] for row in trace_rows] == [1, 2, 3]


def test_trigger_grounding_uses_evidence_from_all_chunks(tmp_path, monkeypatch):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": f"obs-{index}",
                "session_id": "s1",
                "ts": float(index * 180),
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "no"}),
            }
            for index in range(6)
        ],
    )
    opportunity = {
        "category": "anticipate_need",
        "workflow_pattern": "Research followed by manual AI synthesis.",
        "evidence_observation_ids": ["obs-3", "obs-4", "obs-5"],
        "evidence_summary": "Later observations establish the synthesis need.",
        "when_to_offer": "If research begins, offer structured synthesis.",
        "support_strategy": "Collaborative synthesis.",
        "why_high_value": "It avoids repeated manual transfer and prompting.",
        "why_not_incident_specific": "The pattern applies across projects.",
    }
    verified = {
        **opportunity,
        "opportunity_id": "chunk-2-opportunity-0",
        "accepted": True,
        "decision_rationale": "The later evidence establishes a reusable need.",
        "workflow_level_opportunity": True,
        "incident_specific": False,
        "confidence": 0.9,
    }
    trigger_inputs = []

    def fake_completion(**kwargs):
        payload = json.loads(kwargs["user_prompt"])
        if kwargs["system_prompt"] == retrospective.DISCOVERY_SYSTEM_PROMPT:
            opportunities = [opportunity] if payload["chunk_index"] == 2 else []
            return json.dumps({"support_opportunities": opportunities})
        if (
            kwargs["system_prompt"]
            == retrospective._EVIDENCE_VERIFICATION_SYSTEM_PROMPT
        ):
            return json.dumps({"opportunity_decisions": [verified]})
        trigger_inputs.append(payload)
        first_id = payload["timeline"][0]["observation_id"]
        if first_id == "obs-0":
            decision = {
                "opportunity_id": "chunk-2-opportunity-0",
                "accepted": True,
                "decision_rationale": "The need was inferable in this chunk.",
                "trigger_observation_id": "obs-0",
                "rationale": (
                    "The research workflow is beginning and later evidence "
                    "shows that proactive synthesis would save manual effort."
                ),
                "confidence": 0.85,
            }
        else:
            decision = {
                "opportunity_id": "chunk-2-opportunity-0",
                "accepted": False,
                "decision_rationale": "No earlier trigger exists in this chunk.",
            }
        return json.dumps({"trigger_decisions": [decision]})

    monkeypatch.setattr(retrospective, "_complete", fake_completion)
    trace_out = tmp_path / "cross_chunk_trace.jsonl"
    signals = retrospective.derive_retrospective_signals(
        load_records(tmp_path),
        model="fake/model",
        max_observations=3,
        trigger_max_observations=2,
        trace_out=trace_out,
    )

    assert [signal.observation_id for signal in signals] == ["obs-0"]
    assert len(trigger_inputs) == 3
    assert [len(payload["timeline"]) for payload in trigger_inputs] == [2, 2, 2]
    assert all(
        "all_evidence_observations" not in payload
        and payload["verified_opportunities"][0]["evidence_observation_ids"]
        == ["obs-3", "obs-4", "obs-5"]
        and {
            row["observation_id"]
            for row in payload["verified_opportunities"][0][
                "evidence_observation_timestamps"
            ]
        }
        == {"obs-3", "obs-4", "obs-5"}
        for payload in trigger_inputs
    )
    trace_rows = [json.loads(line) for line in trace_out.read_text().splitlines()]
    assert trace_rows[0]["accepted_signals"][0]["observation_id"] == "obs-0"
    assert trace_rows[1]["trigger_reviews"][0]["accepted"] is False


def test_retrospective_resolves_only_unambiguous_observation_id_prefixes():
    valid_ids = {
        "7184d9bd738a42719340606704f2d70a",
        "7184d9be111111111111111111111111",
    }

    assert (
        retrospective._resolve_observation_id("7184d9bd", valid_ids)
        == "7184d9bd738a42719340606704f2d70a"
    )
    assert retrospective._resolve_observation_id("7184d9b", valid_ids) is None
    assert retrospective._resolve_observation_id("missing0", valid_ids) is None


def test_retrospective_prompts_treat_later_manual_ai_use_as_need_evidence():
    discovery = " ".join(retrospective.DISCOVERY_SYSTEM_PROMPT.split())
    verification = " ".join(retrospective._EVIDENCE_VERIFICATION_SYSTEM_PROMPT.split())
    grounding = " ".join(retrospective._TRIGGER_GROUNDING_SYSTEM_PROMPT.split())

    assert "positive evidence" in discovery
    assert "before the later behavior" in discovery
    assert "Do not treat every AI-tool use" in discovery
    assert "CONFIRM that support was needed" in verification
    assert "positive evidence of an earlier need" in grounding
    assert "already active at the proposed trigger" in grounding
    assert "cannot veto their own correction" in grounding


def test_retrospective_retries_empty_and_unparseable_model_responses(monkeypatch):
    responses = iter(
        [
            "",
            "I cannot produce the requested response.",
            json.dumps({"support_opportunities": []}),
        ]
    )
    calls = []

    def fake_completion(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(retrospective, "_complete", fake_completion)
    raw, parsed, attempts = retrospective._complete_json(
        model="fake/model",
        system_prompt="discover",
        user_prompt="timeline",
        operation="test",
        required_list_field="support_opportunities",
    )

    assert raw == '{"support_opportunities": []}'
    assert parsed == {"support_opportunities": []}
    assert [attempt["valid"] for attempt in attempts] == [False, False, True]
    assert attempts[0]["failure"] == "empty response"
    assert "parseable JSON" in attempts[1]["failure"]
    assert len(calls) == 3
    assert "RETRY REQUIREMENT" not in calls[0]["user_prompt"]
    assert "RETRY REQUIREMENT" in calls[1]["user_prompt"]


def test_user_prompt_after_requires_recorded_no_support_decision(tmp_path):
    session = tmp_path / "session_1"
    session.mkdir()
    _append_jsonl(
        session / "observations.jsonl",
        [
            {
                "observation_id": "observer-no-judge-yes",
                "session_id": "s1",
                "ts": 10.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "no"}),
            },
            {
                "observation_id": "observer-yes-judge-no",
                "session_id": "s1",
                "ts": 11.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": json.dumps({"need_support": "yes"}),
            },
            {
                "observation_id": "unknown-polarity",
                "session_id": "s1",
                "ts": 12.0,
                "type": "snapshot",
                "model": "fake",
                "observer_input": "prompt",
                "observer_output": "{}",
            },
        ],
    )
    _append_jsonl(
        session / "decisions.jsonl",
        [
            {
                "decision_id": "decision-yes",
                "session_id": "s1",
                "ts": 13.0,
                "scenario": "everyday_support",
                "phase": "nudge",
                "should_intervene": True,
                "observer": {"fresh_observation_id": "observer-no-judge-yes"},
            },
            {
                "decision_id": "decision-no",
                "session_id": "s1",
                "ts": 14.0,
                "scenario": "everyday_support",
                "phase": "nudge",
                "should_intervene": False,
                "observer": {"fresh_observation_id": "observer-yes-judge-no"},
            },
        ],
    )
    _append_jsonl(
        session / "tutor_calls.jsonl",
        [
            {
                "ts": 20.0,
                "session_id": "s1",
                "trigger": "user_prompt",
                "scenario": "everyday_support",
                "model": "fake",
                "tutor_input": "input",
                "tutor_output": "output",
            }
        ],
    )

    records = flatten_sessions(load_records(tmp_path))
    prompted_observations = {
        signal.observation_id
        for signal in derive_missed_opportunity_signals(records)
        if signal.kind == "user_prompt_after"
    }

    assert prompted_observations == {"observer-yes-judge-no"}


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
    weak_negatives = label_records(
        records,
        include_unverified_no_support=True,
        unverified_no_support_confidence=0.25,
    )
    assert len(weak_negatives) == 1
    assert weak_negatives[0].observation_id == "obs-progress"
    assert weak_negatives[0].need_support == "no"
    assert weak_negatives[0].label_confidence == 0.25
    assert weak_negatives[0].label_sources == ["observer:no_support_unverified"]
    assert weak_negatives[0].target_suggestion_type == "none"
    assert weak_negatives[0].target_suggestion == ""
    assert (
        label_records(
            records,
            include_unverified_no_support=True,
            require_saved_images=True,
        )
        == []
    )


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
