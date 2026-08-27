import json

from personalization import runtime
from personalization.memory.state import (
    InferredInsight,
    InferredMemory,
    SectionedMemory,
)
from personalization.schemas import (
    FeedbackEvent,
    LabeledMoment,
    ObservationRecord,
    SessionRecords,
    ShortWindowSignal,
)


def test_frozen_resource_tracker_command_is_recognized():
    assert (
        runtime._resource_tracker_fd(
            ["from multiprocessing.resource_tracker import main;main(9)"]
        )
        == 9
    )
    assert runtime._resource_tracker_fd(["evolve"]) is None


def test_evolve_rejects_unbounded_llm_concurrency(tmp_path):
    for concurrency in (0, runtime.MAX_EVOLVE_LLM_CONCURRENCY + 1):
        try:
            runtime.process_evolve_step(
                tmp_path / "records",
                tmp_path / "state",
                model="model",
                memory_root=tmp_path / "memory",
                collect_training_screenshots=True,
                llm_concurrency=concurrency,
            )
        except ValueError as error:
            assert "llm_concurrency must be between" in str(error)
        else:
            raise AssertionError("unbounded concurrency should be rejected")


def test_signal_step_appends_feedback_once_and_checkpoints(tmp_path, monkeypatch):
    records = SessionRecords(
        path="session",
        feedback=[
            FeedbackEvent(
                ts=10.0,
                session_id="s1",
                kind="dismiss",
                surface="bubble",
                observation_id="obs-1",
            ),
            FeedbackEvent(
                ts=11.0,
                session_id="s1",
                kind="thumbs_down",
                surface="bubble",
                observation_id="obs-2",
            ),
            FeedbackEvent(
                ts=12.0,
                session_id="s1",
                kind="shown",
                surface="bubble",
                observation_id="obs-3",
            ),
            FeedbackEvent(
                ts=13.0,
                session_id="s1",
                kind="engage",
                surface="bubble",
                observation_id="obs-3",
            ),
            FeedbackEvent(
                ts=14.0,
                session_id="s1",
                kind="need_help",
                surface="bubble",
                observation_id="obs-4",
            ),
        ],
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    state_root = tmp_path / "state"
    state_root.mkdir()
    (state_root / "signals.jsonl").write_text(
        json.dumps({"signal_id": "legacy-shown", "kind": "shown"}) + "\n"
    )

    first = runtime.process_signal_step("records", state_root)
    second = runtime.process_signal_step("records", state_root)

    assert first["new_signals"] == 3
    assert first["removed_legacy_signals"] == 1
    assert second["new_signals"] == 0
    assert len((state_root / "signals.jsonl").read_text().splitlines()) == 3
    checkpoint = json.loads((state_root / "signals_checkpoint.json").read_text())
    assert checkpoint["feedback_event_count"] == 5
    assert checkpoint["signal_type_counts"] == {
        "dismiss": 1,
        "reveal": 1,
        "thumbs_down": 1,
    }


def test_signal_step_retracts_reveal_after_later_thumb_down(tmp_path, monkeypatch):
    records = SessionRecords(
        path="session",
        feedback=[
            FeedbackEvent(
                ts=10.0,
                session_id="s1",
                kind="engage",
                surface="bubble",
                observation_id="obs-1",
            )
        ],
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    state_root = tmp_path / "state"

    first = runtime.process_signal_step("records", state_root)
    records.feedback.append(
        FeedbackEvent(
            ts=11.0,
            session_id="s1",
            kind="thumbs_down",
            surface="history",
            observation_id="obs-1",
        )
    )
    second = runtime.process_signal_step("records", state_root)

    rows = [
        json.loads(line)
        for line in (state_root / "signals.jsonl").read_text().splitlines()
    ]
    assert first["new_signals"] == 1
    assert second["new_signals"] == 1
    assert second["removed_legacy_signals"] == 1
    assert [(row["kind"], row["polarity"]) for row in rows] == [
        ("thumbs_down", "negative")
    ]


def test_evolve_mines_retrospective_opportunities_when_idle(tmp_path, monkeypatch):
    observations = [
        ObservationRecord(
            observation_id=f"obs-{index}",
            session_id="s1",
            ts=float(index),
            type="snapshot",
            model="model",
            observer_input="input",
            observer_output='{"need_support":"no"}',
        )
        for index in range(20)
    ]
    records = SessionRecords(path="session", observations=observations)
    retrospective_signal = ShortWindowSignal(
        signal_id="retrospective-1",
        session_id="s1",
        observation_id="obs-1",
        ts=1.0,
        kind="retrospective:repetitive_work",
        polarity="positive",
        scope="observation",
        expires_at=1801.0,
        confidence=0.9,
        evidence="Repeated workflow",
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    monkeypatch.setattr(
        runtime,
        "derive_retrospective_signals",
        lambda _sessions, **_kwargs: [retrospective_signal],
    )

    def fake_label_records(_records, **kwargs):
        assert kwargs["require_saved_images"] is True
        assert [signal.signal_id for signal in kwargs["additional_signals"]] == [
            "retrospective-1"
        ]
        return []

    monkeypatch.setattr(runtime, "label_records", fake_label_records)
    state_root = tmp_path / "state"

    result = runtime.process_evolve_step(
        tmp_path / "records",
        state_root,
        model="model",
        memory_root=tmp_path / "memory",
        collect_training_screenshots=True,
    )

    assert result == {
        "status": "no_work",
        "moments": 0,
        "new_retrospective_signals": 1,
    }
    checkpoint = json.loads((state_root / "evolve_checkpoint.json").read_text())
    assert checkpoint["retrospective_observation_count"] == 20
    stored = [
        json.loads(line)
        for line in (state_root / "signals.jsonl").read_text().splitlines()
    ]
    assert [row["kind"] for row in stored] == ["retrospective:repetitive_work"]


def test_evolve_continues_when_retrospective_mining_fails(tmp_path, monkeypatch):
    records = SessionRecords(
        path="session",
        observations=[
            ObservationRecord(
                observation_id=f"obs-{index}",
                session_id="s1",
                ts=float(index),
                type="snapshot",
                model="model",
                observer_input="input",
                observer_output='{"need_support":"no"}',
            )
            for index in range(20)
        ],
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    monkeypatch.setattr(
        runtime,
        "derive_retrospective_signals",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("context budget exceeded")
        ),
    )
    monkeypatch.setattr(runtime, "label_records", lambda *_args, **_kwargs: [])
    state_root = tmp_path / "state"

    result = runtime.process_evolve_step(
        tmp_path / "records",
        state_root,
        model="model",
        memory_root=tmp_path / "memory",
        collect_training_screenshots=True,
    )

    assert result == {
        "status": "no_work",
        "moments": 0,
        "retrospective_error": "RuntimeError: context budget exceeded",
    }
    checkpoint = json.loads((state_root / "evolve_checkpoint.json").read_text())
    assert checkpoint["last_retrospective_error"]["observation_count"] == 20
    assert "retrospective_observation_count" not in checkpoint


def test_evolve_rebuilds_active_run_from_older_signal_policy(tmp_path, monkeypatch):
    state_root = tmp_path / "state"
    state_root.mkdir()
    (state_root / "evolve_checkpoint.json").write_text(
        json.dumps(
            {
                "active_run": {
                    "run_id": "legacy-run",
                    "status": "running",
                    "run_dir": str(state_root / "runs" / "legacy-run"),
                    "snapshot_path": str(
                        state_root / "runs" / "legacy-run" / "labeled_moments.jsonl"
                    ),
                }
            }
        )
    )
    monkeypatch.setattr(
        runtime,
        "load_records",
        lambda _root: [SessionRecords(path="session")],
    )

    result = runtime.process_evolve_step(
        tmp_path / "records",
        state_root,
        model="model",
        memory_root=tmp_path / "memory",
        collect_training_screenshots=True,
    )

    assert result == {"status": "no_work", "moments": 0}
    checkpoint = json.loads((state_root / "evolve_checkpoint.json").read_text())
    assert "active_run" not in checkpoint
    assert checkpoint["last_incompatible_run"]["status"] == ("superseded_signal_policy")


def test_evolve_deletes_period_images_only_after_success(tmp_path, monkeypatch):
    records_root = tmp_path / "records"
    records_root.mkdir()
    retained_period_image = records_root / "retained-period-frame.png"
    retained_period_image.write_bytes(b"png")
    observations = []
    labeled = []
    for index in range(8):
        image = records_root / f"frame-{index}.png"
        image.write_bytes(b"png")
        observation_id = f"obs-{index}"
        observations.append(
            ObservationRecord(
                observation_id=observation_id,
                session_id="s1",
                ts=float(index + 1),
                type="snapshot",
                model="model",
                observer_input="input",
                observer_output='{"need_support":"no"}',
                retained_screenshots=(
                    [str(retained_period_image)] if index == 0 else []
                ),
            )
        )
        labeled.append(
            LabeledMoment(
                moment_id=f"moment-{index}",
                observation_id=observation_id,
                session_id="s1",
                ts=float(index + 1),
                need_support="no",
                label_confidence=1.0,
                label_sources=["test"],
                label_rationale="test",
                observer_input="input",
                observer_output='{"need_support":"no"}',
                image_paths=[str(image)],
            )
        )
    records = SessionRecords(path=str(records_root), observations=observations)
    labeled.append(
        LabeledMoment(
            moment_id="moment-missing-image",
            observation_id="obs-missing-image",
            session_id="s1",
            ts=9.0,
            need_support="yes",
            label_confidence=1.0,
            label_sources=["test"],
            label_rationale="test",
            observer_input="input",
            observer_output='{"need_support":"yes"}',
            image_paths=[str(records_root / "not-saved.png")],
        )
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    monkeypatch.setattr(
        runtime,
        "label_records",
        lambda _records, **_kwargs: labeled,
    )

    class FakeLearner:
        def __init__(self, **_kwargs):
            config = _kwargs["config"]
            assert config.gen_max_tokens == 2048
            assert config.role_max_tokens == 4096
            self.memory = SectionedMemory()
            self.memory.apply_ops(
                [
                    {
                        "op": "add",
                        "section": "when_to_support",
                        "content": "Offer help with repeated report formatting.",
                    }
                ]
            )
            self.memory.inferred = InferredMemory(
                insights=[
                    InferredInsight(
                        section="when_to_support",
                        content="The user welcomes help with repetitive formatting.",
                        example_bullet_ids=["m-001"],
                    )
                ]
            )

        def learn(self, _moments, *, out_dir, resume):
            assert resume is False
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "memory_state.json").write_text(
                json.dumps(self.memory.to_json())
            )
            return self.memory

    monkeypatch.setattr(runtime, "SelfEvolvingLearner", FakeLearner)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"keep")

    result = runtime.process_evolve_step(
        records_root,
        tmp_path / "state",
        model="model",
        memory_root=tmp_path / "memory",
        collect_training_screenshots=False,
    )

    assert result == {
        "status": "complete",
        "moments": 8,
        "deleted": 9,
        "skipped_missing_images": 1,
    }
    assert not any(records_root.glob("*.png"))
    assert outside.is_file()
    draft_paths = list(
        (tmp_path / "memory" / "memory_drafts").glob("*/memory_draft.json")
    )
    assert len(draft_paths) == 1
    draft = json.loads(draft_paths[0].read_text())
    assert draft["metrics"]["period_start"] == 1.0
    assert draft["metrics"]["period_end"] == 8.0
    assert draft["metrics"]["moment_count"] == 8
    assert list(draft["metrics"]["examples_by_preference_id"].values()) == [
        ["Offer help with repeated report formatting."]
    ]


def test_evolve_repairs_checkpoint_with_missing_images(tmp_path, monkeypatch):
    state_root = tmp_path / "state"
    run_dir = state_root / "runs" / "period-9"
    snapshot_path = run_dir / "labeled_moments.jsonl"
    moments = []
    for index in range(9):
        image = tmp_path / f"frame-{index}.png"
        if index < 8:
            image.write_bytes(b"png")
        moments.append(
            LabeledMoment(
                moment_id=f"moment-{index}",
                observation_id=f"obs-{index}",
                session_id="s1",
                ts=float(index + 1),
                need_support="no",
                label_confidence=1.0,
                label_sources=["test"],
                label_rationale="test",
                observer_input="input",
                observer_output='{"need_support":"no"}',
                image_paths=[str(image)],
            )
        )
    runtime.write_labeled_moments(snapshot_path, moments)
    (run_dir / "resume_state.json").write_text("{}")
    state_root.mkdir(parents=True, exist_ok=True)
    (state_root / "evolve_checkpoint.json").write_text(
        json.dumps(
            {
                "active_run": {
                    "run_id": "period-9",
                    "status": "running",
                    "signal_policy_version": runtime.SIGNAL_POLICY_VERSION,
                    "period_start": 1.0,
                    "period_end": 9.0,
                    "snapshot_path": str(snapshot_path),
                    "run_dir": str(run_dir),
                    "images": [str(image) for image in tmp_path.glob("frame-*.png")],
                }
            }
        )
    )

    class FakeLearner:
        def __init__(self, **_kwargs):
            self.memory = SectionedMemory()

        def learn(self, training_moments, *, out_dir, resume):
            assert len(training_moments) == 8
            assert resume is False
            (out_dir / "memory_state.json").write_text(
                json.dumps(self.memory.to_json())
            )
            return self.memory

    monkeypatch.setattr(runtime, "SelfEvolvingLearner", FakeLearner)

    result = runtime.process_evolve_step(
        tmp_path / "records",
        state_root,
        model="model",
        memory_root=tmp_path / "memory",
        collect_training_screenshots=True,
    )

    assert result == {
        "status": "complete",
        "moments": 8,
        "deleted": 0,
        "skipped_missing_images": 1,
    }
    repaired = runtime.read_labeled_moments(snapshot_path)
    assert len(repaired) == 8
    assert all(moment.image_paths for moment in repaired)
