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
)


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
            )
        ],
    )
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    state_root = tmp_path / "state"

    first = runtime.process_signal_step("records", state_root)
    second = runtime.process_signal_step("records", state_root)

    assert first["new_signals"] == 1
    assert second["new_signals"] == 0
    assert len((state_root / "signals.jsonl").read_text().splitlines()) == 1
    checkpoint = json.loads((state_root / "signals_checkpoint.json").read_text())
    assert checkpoint["feedback_event_count"] == 1


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
    monkeypatch.setattr(runtime, "load_records", lambda _root: [records])
    monkeypatch.setattr(runtime, "label_records", lambda _records: labeled)

    class FakeLearner:
        def __init__(self, **_kwargs):
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

    assert result == {"status": "complete", "moments": 8, "deleted": 9}
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
