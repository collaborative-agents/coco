import json
import threading
import time
from types import SimpleNamespace

import pytest
from personalization.dataset_builder import build_sft_examples
from personalization.memory import (
    EvolveConfig,
    InferredInsight,
    InferredMemory,
    MemoryOp,
    SectionedMemory,
    SelfEvolvingLearner,
    UtilityStats,
    select_evolution_moments,
)
from personalization.memory import evaluate as memory_evaluate
from personalization.memory import evolve as memory_evolve
from personalization.memory import roles as memory_roles
from personalization.schemas import LabeledMoment
from personalization.utils.llm_resilience import MAX_PERSONALIZATION_IMAGE_BYTES


def test_role_completion_uses_low_latency_qwen_settings(monkeypatch):
    captured = {}

    def fake_chat_completion(messages, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="done"), {}

    monkeypatch.setattr(memory_roles, "chat_completion", fake_chat_completion)

    result = memory_roles._complete_role(
        [{"role": "user", "content": "test"}],
        model="hosted_vllm/qwen3.5-9b",
        temperature=0.0,
        max_tokens=2048,
        operation="personalization.test",
    )

    assert result == "done"
    assert captured["max_tokens"] == 2048
    assert captured["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }


def test_personalization_skips_missing_and_oversized_images(tmp_path):
    small = tmp_path / "small.jpg"
    small.write_bytes(b"small")
    oversized = tmp_path / "oversized.png"
    oversized.write_bytes(b"x" * (MAX_PERSONALIZATION_IMAGE_BYTES + 1))
    moment = LabeledMoment(
        moment_id="moment-1",
        observation_id="obs-1",
        session_id="s1",
        ts=1.0,
        need_support="no",
        label_confidence=1.0,
        label_sources=["test"],
        label_rationale="test",
        observer_input="input",
        observer_output='{"need_support":"no"}',
        image_paths=[str(small), str(oversized), str(tmp_path / "missing.jpg")],
    )

    assert memory_roles._moment_image_paths(moment, image_root=None, max_images=2) == [
        small
    ]


def test_sectioned_memory_applies_ops_votes_and_exports_preferences():
    memory = SectionedMemory()
    assert (
        memory.apply_ops(
            [
                MemoryOp(
                    op="add",
                    section="when_to_support",
                    content="Support repeated citation lookup tasks.",
                    evidence_moment_ids=["m1"],
                )
            ]
        )
        == 1
    )
    assert (
        memory.apply_ops(
            [
                MemoryOp(
                    op="add",
                    section="when_to_support",
                    content="Support repeated citation lookup tasks.",
                )
            ]
        )
        == 0
    )
    bid = next(iter(memory.bullets))
    memory.vote([bid], [])
    prefs = memory.to_learned_preferences()
    assert prefs[0].section == "when_to_support"
    assert prefs[0].confidence == 0.95
    assert prefs[0].evidence_moment_ids == ["m1"]


def test_inferred_memory_groups_detailed_bullets_as_examples():
    memory = SectionedMemory()
    memory.apply_ops(
        [
            MemoryOp(
                op="add",
                section="when_to_support",
                content="Offer help after repeated failed test runs.",
                evidence_moment_ids=["moment-1"],
            ),
            MemoryOp(
                op="add",
                section="when_to_stay_silent",
                content="Stay silent while the user is making visible progress.",
                evidence_moment_ids=["moment-2"],
            ),
        ]
    )
    support_id, silent_id = memory.bullets
    memory.vote([support_id], [])
    memory.inferred = InferredMemory.from_dict(
        {
            "insights": [
                {
                    "section": "when_to_support",
                    "content": (
                        "To maintain momentum, the user prefers intervention at a "
                        "demonstrated impasse, not merely risk."
                    ),
                    "example_bullet_ids": [support_id, "invented-id"],
                },
                {
                    "section": "when_to_stay_silent",
                    "content": (
                        "To protect focus, the user prefers silence during visible "
                        "progress."
                    ),
                    "example_bullet_ids": [silent_id],
                },
            ],
        },
        valid_bullet_ids=set(memory.bullets),
    )

    rendered = memory.render(with_ids=False)
    assert "## Inferred user model" in rendered
    assert "To maintain momentum" in rendered
    assert "intervention at a demonstrated impasse" in rendered
    assert "Offer help after repeated failed test runs." in rendered
    assert "invented-id" not in rendered
    assert memory.render_evolved(with_ids=True).startswith(
        "## When to proactively support"
    )

    restored = SectionedMemory.from_json(memory.to_json())
    assert restored.render(with_ids=False) == rendered
    preferences = restored.to_learned_preferences()
    assert [item.content for item in preferences] == [
        (
            "To maintain momentum, the user prefers intervention at a demonstrated "
            "impasse, not merely risk."
        ),
        "To protect focus, the user prefers silence during visible progress.",
    ]
    assert preferences[0].evidence_moment_ids == ["moment-1"]


def test_sectioned_memory_loads_evolved_markdown():
    memory = SectionedMemory.from_markdown(
        """\
## When to proactively support
- [m-041] Help after repeated failures.

## When to stay silent
- Stay silent while the user is making progress.

## Unknown section
- Ignore bullets outside the evolved taxonomy.
"""
    )

    assert [item.id for item in memory.bullets.values()] == ["m-001", "m-002"]
    assert [item.content for item in memory.bullets.values()] == [
        "Help after repeated failures.",
        "Stay silent while the user is making progress.",
    ]
    assert [item.section for item in memory.bullets.values()] == [
        "when_to_support",
        "when_to_stay_silent",
    ]


def test_inferred_memory_requires_insights_with_valid_examples():
    inferred = InferredMemory.from_dict(
        {
            "insights": [
                {
                    "section": "general",
                    "content": "An unsupported insight.",
                    "example_bullet_ids": ["invented-id"],
                }
            ],
        },
        valid_bullet_ids={"m-001"},
    )
    assert inferred is None


def test_inference_role_selects_existing_bullets_without_count_limits(monkeypatch):
    memory = SectionedMemory()
    memory.apply_ops(
        [
            MemoryOp(
                op="add",
                section="when_to_support",
                content="Help after repeated failures.",
            )
        ]
    )
    bullet_id = next(iter(memory.bullets))

    def fake_complete(messages, **kwargs):
        assert f"[{bullet_id}] Help after repeated failures." in messages[1]["content"]
        assert kwargs["operation"] == "self_evolving_memory.infer"
        assert "predetermined count" in messages[0]["content"]
        return json.dumps(
            {
                "insights": [
                    {
                        "section": "when_to_support",
                        "content": (
                            "To recover momentum, the user prefers help at a "
                            "demonstrated impasse."
                        ),
                        "example_bullet_ids": [bullet_id, "invented-id"],
                    }
                ],
            }
        )

    monkeypatch.setattr(memory_roles, "_complete_role", fake_complete)
    inferred = memory_roles.infer_memory("test-model", memory)

    assert inferred is not None
    assert inferred.insights[0].example_bullet_ids == [bullet_id]


def test_learner_writes_inferred_memory_as_final_output(monkeypatch, tmp_path):
    memory = SectionedMemory()
    memory.apply_ops(
        [
            MemoryOp(
                op="add",
                section="when_to_support",
                content="Help after repeated failures.",
            )
        ]
    )
    bullet_id = next(iter(memory.bullets))

    def fake_infer(model, evolved_memory, **kwargs):
        assert evolved_memory.render_evolved(with_ids=True).startswith(
            "## When to proactively support"
        )
        return InferredMemory(
            insights=[
                InferredInsight(
                    section="when_to_support",
                    content=(
                        "To recover momentum, the user prefers help at a "
                        "demonstrated impasse."
                    ),
                    example_bullet_ids=[bullet_id],
                )
            ],
        )

    monkeypatch.setattr(memory_evolve, "infer_memory", fake_infer)
    learner = SelfEvolvingLearner(prediction_model="test-model", memory=memory)
    learner.learn([], out_dir=tmp_path, log=False)

    memory_md = (tmp_path / "memory.md").read_text()
    assert "## Inferred user model" in memory_md
    assert "user prefers help at a demonstrated impasse." in memory_md
    assert "Examples:" in memory_md
    state = json.loads((tmp_path / "memory_state.json").read_text())
    assert state["inferred"]["insights"][0]["example_bullet_ids"] == [bullet_id]


def test_cost_sensitive_utility_penalizes_false_alarms_and_invalid_outputs():
    stats = UtilityStats()
    stats.add(
        [
            {"pred": "yes", "gt": "yes"},
            {"pred": "no", "gt": "no"},
            {"pred": "yes", "gt": "no"},
            {"pred": "no", "gt": "yes"},
            {"pred": None, "gt": "yes"},
        ]
    )

    assert stats.to_json() == {
        "true_positive": 1,
        "true_negative": 1,
        "false_positive": 1,
        "false_negative": 1,
        "invalid": 1,
        "total": 5,
    }
    assert stats.utility(false_positive_cost=2.0, false_negative_cost=1.0) == -0.6


def test_evolution_selection_keeps_errors_unknowns_and_adjacent_correct():
    def moment(moment_id, need_support, original, *, session_id="s1"):
        output = {} if original is None else {"need_support": original}
        return LabeledMoment(
            moment_id=moment_id,
            observation_id=f"obs-{moment_id}",
            session_id=session_id,
            ts=0.0,
            need_support=need_support,
            label_confidence=1.0,
            label_sources=["test"],
            label_rationale="test",
            observer_input="test",
            observer_output=json.dumps(output),
        )

    selection = select_evolution_moments(
        [
            moment("correct-before", "no", "no"),
            moment("error", "yes", "no"),
            moment("correct-after", "yes", "yes"),
            moment("correct-downsampled", "no", "no"),
            moment("unknown", "yes", None),
        ],
        correct_sample_rate=0.0,
    )

    assert [item.moment_id for item in selection.moments] == [
        "correct-before",
        "error",
        "correct-after",
        "unknown",
    ]
    assert selection.original_disagreements == 1
    assert selection.unknown_original_predictions == 1
    assert selection.correct_available == 3
    assert selection.correct_retained == 2
    assert selection.adjacent_correct_anchors == 2


def test_learner_preserves_source_order_by_default(monkeypatch):
    batches = []

    def fake_generate_batch(self, batch, memory_text):
        batches.append(list(batch))
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(SelfEvolvingLearner, "_generate_batch", fake_generate_batch)
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=2),
    )

    learner.learn(["first", "second", "third"], log=False)

    assert batches == [["first", "second"], ["third"]]


def test_learner_sends_generation_requests_in_parallel(monkeypatch):
    lock = threading.Lock()
    active = 0
    max_active = 0

    def fake_generate(*_args, **_kwargs):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return {"pred": "no", "gt": "no", "correct": True}

    monkeypatch.setattr(memory_evolve, "generate", fake_generate)
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(batch_size=4, concurrency=4),
    )

    results = learner._generate_batch(["a", "b", "c", "d"], "memory")

    assert len(results) == 4
    assert max_active > 1


def test_learner_skips_exhausted_transient_batch_and_continues(monkeypatch, tmp_path):
    class GatewayTimeout(RuntimeError):
        status_code = 504

    calls = []

    def generate_batch(self, batch, memory_text):
        calls.append(list(batch))
        if batch == ["second"]:
            raise GatewayTimeout("504 Gateway Time-out after retries")
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(SelfEvolvingLearner, "_generate_batch", generate_batch)
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=1, concurrency=1),
    )

    learner.learn(["first", "second", "third"], out_dir=tmp_path, log=False)

    assert calls == [["first"], ["second"], ["third"]]
    assert learner.epochs_completed == 1
    assert learner.last_utility == 1.0
    assert len(learner.skipped_batches) == 1
    skipped = learner.skipped_batches[0]
    assert skipped == {
        "event": "batch_skipped",
        "epoch": 1,
        "batch": 2,
        "moment_count": 1,
        "moment_ids": ["0"],
        "error_type": "GatewayTimeout",
        "error": "504 Gateway Time-out after retries",
        "batch_duration_s": skipped["batch_duration_s"],
    }
    assert skipped["batch_duration_s"] >= 0
    checkpoint = json.loads((tmp_path / "resume_state.json").read_text())
    assert checkpoint["status"] == "complete"
    assert checkpoint["skipped_batches"] == learner.skipped_batches
    progress = [
        json.loads(line)
        for line in (tmp_path / "progress.jsonl").read_text().splitlines()
    ]
    assert [row.get("event") for row in progress] == [
        None,
        "batch_skipped",
        None,
        "epoch_end",
    ]


def test_skipped_batch_rolls_back_partial_memory_changes(monkeypatch, tmp_path):
    class GatewayTimeout(RuntimeError):
        status_code = 504

    memory = SectionedMemory()
    memory.apply_ops(
        [
            MemoryOp(
                op="add",
                section="when_to_support",
                content="Offer help after repeated failures.",
            )
        ]
    )
    bullet_id = next(iter(memory.bullets))
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_generate_batch",
        lambda self, batch, memory_text: [
            {"pred": "no", "gt": "yes", "correct": False}
        ],
    )
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [
            {
                "helpful_bullet_ids": [],
                "harmful_bullet_ids": [bullet_id],
            }
        ],
    )

    def curator_timeout(*args, **kwargs):
        raise GatewayTimeout("curator timed out after retries")

    monkeypatch.setattr(memory_evolve, "curate", curator_timeout)
    monkeypatch.setattr(memory_evolve, "infer_memory", lambda *args, **kwargs: None)
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        memory=memory,
        config=EvolveConfig(epochs=1, batch_size=1, concurrency=1),
    )

    learner.learn(["moment"], out_dir=tmp_path, log=False)

    assert learner.memory.bullets[bullet_id].harmful == 0
    assert len(learner.skipped_batches) == 1


def test_learner_resumes_after_last_completed_batch(monkeypatch, tmp_path):
    moments = ["first", "second", "third"]
    config = EvolveConfig(epochs=1, batch_size=2, concurrency=1)
    calls = []

    def interrupted_generate(self, batch, memory_text):
        calls.append(list(batch))
        if batch == ["third"]:
            raise RuntimeError("endpoint disconnected")
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_generate_batch",
        interrupted_generate,
    )
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=config,
    )
    with pytest.raises(RuntimeError, match="endpoint disconnected"):
        learner.learn(moments, out_dir=tmp_path, log=False)

    checkpoint = json.loads((tmp_path / "resume_state.json").read_text())
    assert checkpoint["next_epoch"] == 1
    assert checkpoint["next_batch"] == 2
    assert calls == [["first", "second"], ["third"]]

    resumed_calls = []

    def resumed_generate(self, batch, memory_text):
        resumed_calls.append(list(batch))
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_generate_batch",
        resumed_generate,
    )
    resumed = SelfEvolvingLearner(
        prediction_model="test-model",
        config=config,
    )
    resumed.learn(moments, out_dir=tmp_path, log=False, resume=True)

    assert resumed_calls == [["third"]]
    assert resumed.epochs_completed == 1
    completed = json.loads((tmp_path / "resume_state.json").read_text())
    assert completed["status"] == "complete"
    rows = [
        json.loads(line)
        for line in (tmp_path / "progress.jsonl").read_text().splitlines()
    ]
    assert [(row.get("epoch"), row.get("batch")) for row in rows] == [
        (1, 1),
        (1, 2),
        (1, None),
    ]
    assert all(
        row["batch_duration_s"] >= 0 for row in rows if row.get("batch") is not None
    )


def test_learner_resume_rejects_changed_dataset(monkeypatch, tmp_path):
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_generate_batch",
        lambda self, batch, memory_text: [
            {"pred": "no", "gt": "no", "correct": True} for _ in batch
        ],
    )
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=2),
    )
    learner.learn(["first"], out_dir=tmp_path, log=False)

    resumed = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=2),
    )
    with pytest.raises(ValueError, match="dataset changed"):
        resumed.learn(["different"], out_dir=tmp_path, log=False, resume=True)


def test_learner_restarts_when_resume_configuration_changed(monkeypatch, tmp_path):
    calls = []

    def fake_generate(self, batch, memory_text):
        calls.append(list(batch))
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(SelfEvolvingLearner, "_generate_batch", fake_generate)
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    monkeypatch.setattr(memory_evolve, "infer_memory", lambda *args, **kwargs: None)
    original = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=2),
    )
    original.learn(["first", "second"], out_dir=tmp_path, log=False)
    calls.clear()

    committed_memory = SectionedMemory()
    committed_memory.apply_ops(
        [
            MemoryOp(
                op="add",
                section="when_to_support",
                content="This committed memory must survive the restart.",
            )
        ]
    )
    restarted = SelfEvolvingLearner(
        prediction_model="test-model",
        memory=committed_memory,
        config=EvolveConfig(epochs=1, batch_size=1),
    )

    restarted.learn(
        ["first", "second"],
        out_dir=tmp_path,
        log=False,
        resume=True,
    )

    assert calls == [["first"], ["second"]]
    assert restarted.resume_restart_reason == (
        "cannot resume because the configuration changed"
    )
    assert any(
        bullet.content == "This committed memory must survive the restart."
        for bullet in restarted.memory.bullets.values()
    )
    progress = [
        json.loads(line)
        for line in (tmp_path / "progress.jsonl").read_text().splitlines()
    ]
    assert progress[0] == {
        "event": "resume_restarted",
        "reason": "cannot resume because the configuration changed",
    }
    assert json.loads((tmp_path / "resume_state.json").read_text())["status"] == (
        "complete"
    )


def test_learner_resumes_legacy_memory_and_progress_checkpoint(monkeypatch, tmp_path):
    (tmp_path / "memory_state.json").write_text(json.dumps(SectionedMemory().to_json()))
    (tmp_path / "progress.jsonl").write_text(
        json.dumps(
            {
                "epoch": 1,
                "batch": 1,
                "running_confusion": {
                    "true_positive": 0,
                    "true_negative": 2,
                    "false_positive": 0,
                    "false_negative": 0,
                    "invalid": 0,
                    "total": 2,
                },
            }
        )
        + "\n"
    )
    calls = []

    def fake_generate(self, batch, memory_text):
        calls.append(list(batch))
        return [{"pred": "no", "gt": "no", "correct": True} for _ in batch]

    monkeypatch.setattr(SelfEvolvingLearner, "_generate_batch", fake_generate)
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=1, batch_size=2),
    )
    learner.learn(
        ["first", "second", "third"],
        out_dir=tmp_path,
        log=False,
        resume=True,
    )

    assert calls == [["third"]]
    assert (
        json.loads((tmp_path / "resume_state.json").read_text())["status"] == "complete"
    )


def test_learner_stops_when_target_utility_is_reached(monkeypatch):
    calls = 0

    def fake_generate_batch(self, batch, memory_text):
        nonlocal calls
        calls += 1
        return [{"pred": "yes", "gt": "yes", "correct": True} for _moment in batch]

    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_generate_batch",
        fake_generate_batch,
    )
    monkeypatch.setattr(
        SelfEvolvingLearner,
        "_reflect_batch",
        lambda self, results, memory_text: [],
    )
    learner = SelfEvolvingLearner(
        prediction_model="test-model",
        config=EvolveConfig(epochs=5, batch_size=2, target_utility=0.8),
    )

    learner.learn([object(), object()], log=False)

    assert calls == 2  # one training batch plus one fixed post-epoch evaluation
    assert learner.epochs_completed == 1
    assert learner.last_utility == 1.0
    assert learner.target_reached is True


def test_learner_uses_separate_prediction_and_evolution_models(monkeypatch):
    calls = []

    def fake_generate(model, moment, memory_text, **kwargs):
        calls.append(("generate", model))
        return {"pred": "no", "gt": "yes", "correct": False}

    def fake_reflect(model, result, memory_text, **kwargs):
        calls.append(("reflect", model))
        return {
            "verdict": "wrong",
            "reflection": "The assistant should have helped.",
            "helpful_bullet_ids": [],
            "harmful_bullet_ids": [],
            "proposed_insights": [],
        }

    def fake_curate(model, memory, reflections, **kwargs):
        calls.append(("curate", model))
        return [{"op": "add", "section": "general", "content": "Test insight."}]

    def fake_infer(model, memory, **kwargs):
        calls.append(("infer", model))
        return None

    monkeypatch.setattr(memory_evolve, "generate", fake_generate)
    monkeypatch.setattr(memory_evolve, "reflect", fake_reflect)
    monkeypatch.setattr(memory_evolve, "curate", fake_curate)
    monkeypatch.setattr(memory_evolve, "infer_memory", fake_infer)
    learner = SelfEvolvingLearner(
        prediction_model="prediction-model",
        evolution_model="evolution-model",
        config=EvolveConfig(epochs=1, batch_size=1, concurrency=1),
    )

    learner.learn([object()], log=False)

    assert calls == [
        ("generate", "prediction-model"),
        ("reflect", "evolution-model"),
        ("curate", "evolution-model"),
        ("infer", "evolution-model"),
    ]


def test_inference_evaluation_counts_invalid_predictions_as_incorrect(monkeypatch):
    moments = [
        "true_positive",
        "false_positive",
        "false_negative",
        "true_negative",
        "invalid",
    ]

    def fake_generate(model, moment, memory_text, **kwargs):
        predictions = {
            "true_positive": ("yes", "yes"),
            "false_positive": ("yes", "no"),
            "false_negative": ("no", "yes"),
            "true_negative": ("no", "no"),
            "invalid": (None, "yes"),
        }
        prediction, ground_truth = predictions[moment]
        return {
            "correct": prediction == ground_truth and prediction is not None,
            "pred": prediction,
            "gt": ground_truth,
        }

    monkeypatch.setattr(memory_evaluate, "generate", fake_generate)
    result = memory_evaluate.evaluate_memory_accuracy(
        "test-model",
        moments,
        "test memory",
        image_root=None,
        max_images=1,
        max_tokens=100,
        concurrency=2,
    )

    assert result == {
        "accuracy": 0.4,
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5,
        "false_alarm_rate": 0.5,
        "correct": 2,
        "total": 5,
        "valid_predictions": 4,
        "invalid_predictions": 1,
        "confusion_matrix": {
            "true_positive": 1,
            "false_positive": 1,
            "false_negative": 1,
            "true_negative": 1,
        },
    }


def test_build_sft_from_labeled_moments():
    labeled = LabeledMoment(
        moment_id="moment-1",
        observation_id="obs-1",
        session_id="s1",
        ts=1.0,
        need_support="yes",
        label_confidence=0.9,
        label_sources=["feedback:engage"],
        label_rationale="User engaged.",
        observer_input="screen context",
        observer_output="{}",
        image_paths=["img.png"],
        target_observation="The user repeats a task.",
        target_user_intent="Finish the task.",
        target_suggestion_type="direct_message",
        target_suggestion="Try batching this.",
    )
    examples = build_sft_examples([labeled])
    assert examples[0].images == ["img.png"]
    assistant = json.loads(examples[0].messages[2]["content"])
    assert assistant["need_support"] == "yes"
    assert assistant["suggestion"] == "Try batching this."


def test_build_sft_includes_no_help_target_without_suggestion():
    labeled = LabeledMoment(
        moment_id="moment-no-help",
        observation_id="obs-no-help",
        session_id="s1",
        ts=2.0,
        need_support="no",
        label_confidence=1.0,
        label_sources=["observer:no_support_unverified"],
        label_rationale="Weak unverified observer no-support prediction.",
        observer_input="screen context",
        observer_output='{"need_support":"yes"}',
        target_observation="The user is progressing without needing help.",
        target_user_intent="Continue the task independently.",
        target_suggestion_type="direct_message",
        target_suggestion="This stale suggestion must not be exported.",
    )

    examples = build_sft_examples([labeled])
    assistant = json.loads(examples[0].messages[2]["content"])

    assert assistant == {
        "observation": "The user is progressing without needing help.",
        "user_intent": "Continue the task independently.",
        "need_support": "no",
        "rationale": "Weak unverified observer no-support prediction.",
        "suggestion_type": "none",
        "suggestion": "",
    }
    assert examples[0].metadata["label_sources"] == ["observer:no_support_unverified"]
