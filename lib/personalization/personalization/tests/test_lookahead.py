import json
from types import SimpleNamespace

from memory.models import ObservationInput, PropositionDraft
from memory.store import MemoryStore
from personalization import lookahead
from personalization.schemas import LabeledMoment, ObservationRecord, SessionRecords


def _observation(
    observation_id: str,
    ts: float,
    observation: str,
    intent: str,
    *,
    retained_screenshots: list[str] | None = None,
) -> ObservationRecord:
    return ObservationRecord(
        observation_id=observation_id,
        session_id=None,
        ts=ts,
        type="snapshot",
        model="observer",
        observer_input=f"Actions and screen context for {observation_id}: {observation}",
        observer_output=json.dumps(
            {
                "status": "observing",
                "observation": observation,
                "user_intent": intent,
            }
        ),
        retained_screenshots=retained_screenshots or [],
    )


def _label(
    observation_id: str,
    ts: float,
    *,
    moment_id: str = "future-moment",
    observation: str = "The API request fails authentication.",
    intent: str = "Fix API authentication.",
) -> LabeledMoment:
    return LabeledMoment(
        moment_id=moment_id,
        observation_id=observation_id,
        session_id=None,
        ts=ts,
        need_support="yes",
        label_confidence=1.0,
        label_sources=["feedback:need_help"],
        label_rationale="The user asked for help with API authentication.",
        observer_input="future actions",
        observer_output="{}",
        target_observation=observation,
        target_user_intent=intent,
        target_suggestion_type="direct_message",
        target_suggestion="Check the API token and Authorization header.",
    )


def _memory_store(tmp_path, observations, proposition_text, evidence_ids):
    store = MemoryStore(tmp_path / "memory.db")
    for observation in observations:
        store.add_observation(
            ObservationInput(
                id=observation.observation_id,
                content=observation.observer_output,
                created_at=observation.ts,
            )
        )
    store.insert_proposition(
        PropositionDraft(
            proposition_text,
            "The linked observations provide supporting evidence.",
            confidence=8,
            decay=7,
        ),
        evidence_ids,
    )
    return store


def test_intent_retrieval_uses_memory_evidence_and_revision_overlay(tmp_path):
    past_docs = _observation(
        "past-docs",
        10.0,
        "The user reads general API documentation.",
        "Understand the API.",
    )
    past_auth = _observation(
        "past-auth",
        20.0,
        "A terminal shows an invalid token error from the API.",
        "Authenticate an API request.",
    )
    future = _observation(
        "future",
        30.0,
        "The API request still fails.",
        "Fix the request.",
    )
    session_a = SessionRecords(
        path="/records/session_a",
        observations=[past_docs, past_auth, future],
    )
    cross_session = _observation(
        "cross-session",
        25.0,
        "A prior project also showed an invalid API token.",
        "Repair API authentication.",
    )
    after_future = _observation(
        "after-future",
        40.0,
        "The user fixes the API token.",
        "Complete API authentication.",
    )
    session_b = SessionRecords(
        path="/records/session_b",
        observations=[cross_session, after_future],
    )
    store = _memory_store(
        tmp_path,
        [past_auth, cross_session, after_future],
        "The user repairs invalid API authentication tokens",
        ["past-auth", "cross-session", "after-future"],
    )
    base = _label("future", 30.0, intent="Fix the request.")
    revised = _label(
        "future",
        30.0,
        intent="Repair the invalid API authentication token.",
    )

    tasks, eligible = lookahead.build_lookahead_tasks(
        [session_a, session_b],
        store,
        [base],
        revised=[revised],
        limit=1,
        max_past_observations=3,
        memory_proposition_limit=5,
        memory_evidence_limit=5,
    )

    assert eligible == 1
    assert len(tasks) == 1
    assert tasks[0].future_label.target_user_intent == (
        "Repair the invalid API authentication token."
    )
    assert tasks[0].future_was_revised is True
    assert {item.context.record.observation_id for item in tasks[0].past} == {
        "past-auth",
        "cross-session",
    }
    assert "past-docs" not in {
        item.context.record.observation_id for item in tasks[0].past
    }
    assert "after-future" not in {
        item.context.record.observation_id for item in tasks[0].past
    }
    assert tasks[0].past[0].memory_propositions[0]["text"] == (
        "The user repairs invalid API authentication tokens"
    )


def test_teacher_receives_hindsight_context_and_emits_auditable_artifact(
    tmp_path,
    monkeypatch,
):
    frame = tmp_path / "past.png"
    frame.write_bytes(b"fake-png")
    past = _observation(
        "past-auth",
        20.0,
        "Terminal shows HTTP 401 and an invalid token message.",
        "Authenticate an API request.",
        retained_screenshots=[str(frame)],
    )
    future = _observation(
        "future",
        30.0,
        "The request still fails with HTTP 401.",
        "Fix API authentication.",
    )
    task = lookahead.LookAheadTask(
        future_label=_label("future", 30.0),
        future_context=lookahead.ObservationContext(future, "/records/session_a"),
        past=[
            lookahead.RetrievedObservation(
                context=lookahead.ObservationContext(past, "/records/session_a"),
                relevance_score=0.91,
                seconds_before_need=10.0,
                memory_observation_content=past.observer_output,
                memory_propositions=[
                    {
                        "id": 7,
                        "text": "The user debugs API authentication",
                        "reasoning": "Observed invalid-token errors.",
                        "score": 0.91,
                        "confidence": 8,
                        "durability": 7,
                    }
                ],
            )
        ],
    )
    captured = {"calls": []}

    def fake_chat_completion(messages, **kwargs):
        captured["calls"].append(messages)
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        if len(captured["calls"]) == 1:
            response = SimpleNamespace(
                content=[SimpleNamespace(text='{"critique": "wrong key"}')],
            )
            return response, {"model": kwargs["model"], "total_tokens": 12}
        text = json.dumps(
            {
                "critiques": [
                    {
                        "observation_id": "past-auth",
                        "useful_for_future_need": True,
                        "helpfulness_score": 5,
                        "critique": "The note should retain the exact HTTP status.",
                        "improved_observation": (
                            "Terminal shows HTTP 401 and an invalid-token error "
                            "while the user authenticates the API request."
                        ),
                    }
                ]
            }
        )
        response = SimpleNamespace(
            content=[SimpleNamespace(text=text)],
        )
        metrics = {
            "model": kwargs["model"],
            "total_tokens": 123,
            "modality": "vlm",
        }
        return response, metrics

    monkeypatch.setattr(lookahead, "chat_completion", fake_chat_completion)

    artifact = lookahead.critique_task(
        task,
        model="fake/teacher",
        max_action_chars=5000,
        max_observation_words=30,
        max_tokens=1000,
        include_images=True,
        max_images_per_moment=1,
    )

    system_prompt = captured["messages"][0]["content"]
    user_content = captured["messages"][1]["content"]
    assert "HINDSIGHT WITHOUT LEAKAGE" in system_prompt
    assert "within 30 words" in system_prompt
    assert any(block["type"] == "image_url" for block in user_content)
    assert captured["kwargs"]["temperature"] == 0.0
    assert len(captured["calls"]) == 2
    assert "previous response was invalid" in captured["calls"][1][-1]["content"]
    assert "past-auth" in captured["calls"][1][-1]["content"]
    assert artifact["future_moment"]["observation_id"] == "future"
    assert artifact["future_moment"]["used_revised_label_target"] is False
    assert artifact["retrieved_past"][0]["retrieval_score"] == 0.91
    assert artifact["critiques"][0]["helpfulness_score"] == 5
    assert artifact["critiques"][0]["within_word_budget"] is True
    assert artifact["llm_metrics"]["total_tokens"] == 123
    assert artifact["teacher_attempts"] == 2
    assert len(artifact["teacher_raw_attempts"]) == 2
    assert len(artifact["llm_metrics_attempts"]) == 2
    assert artifact["teacher_config"]["include_images"] is True
    assert artifact["teacher_config"]["retries"] == 2


def test_limit_bounds_future_teacher_tasks(tmp_path):
    past = _observation("past", 1.0, "User edits API code.", "Call an API.")
    sessions = [
        SessionRecords(
            path="/records/session_a",
            observations=[
                past,
                _observation("future-1", 2.0, "First API error.", "Fix first error."),
                _observation("future-2", 3.0, "Second API error.", "Fix second error."),
            ],
        )
    ]
    labels = [
        _label("future-1", 2.0, moment_id="future-moment-1"),
        _label("future-2", 3.0, moment_id="future-moment-2"),
    ]
    store = _memory_store(
        tmp_path,
        [past],
        "The user fixes API authentication errors",
        ["past"],
    )

    tasks, eligible = lookahead.build_lookahead_tasks(
        sessions,
        store,
        labels,
        limit=1,
        max_past_observations=2,
        memory_proposition_limit=5,
        memory_evidence_limit=5,
    )

    assert eligible == 2
    assert len(tasks) == 1


def test_run_lookahead_critique_reports_progress_and_preserves_order(monkeypatch):
    tasks = [SimpleNamespace(name="first"), SimpleNamespace(name="second")]
    progress_updates = []

    def fake_critique_task(task, **kwargs):
        return {"name": task.name}

    class FakeProgress:
        def __init__(self, *, total, desc, unit, disable):
            progress_updates.append(("config", total, desc, unit, disable))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def update(self):
            progress_updates.append(("update", 1))

    monkeypatch.setattr(lookahead, "critique_task", fake_critique_task)
    monkeypatch.setattr(lookahead, "tqdm", FakeProgress)

    artifacts = lookahead.run_lookahead_critique(
        tasks,
        model="fake/teacher",
        concurrency=2,
        show_progress=True,
    )

    assert artifacts == [{"name": "first"}, {"name": "second"}]
    assert progress_updates == [
        ("config", 2, "Critiquing observations", "moment", False),
        ("update", 1),
        ("update", 1),
    ]
