from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sensing import segment_processor, sensing_server
from sensing.segment_processor import AiTutoringProcessor


def test_build_memory_engine_uses_shared_database_and_observer_model(
    monkeypatch, tmp_path
):
    db_path = tmp_path / "memory" / "memory.db"
    monkeypatch.setenv("COCO_MEMORY_DB_PATH", str(db_path))
    monkeypatch.delenv("MEMORY_MODEL", raising=False)
    monkeypatch.delenv("COCO_USER_NAME", raising=False)
    monkeypatch.delenv("MEMORY_MIN_BATCH_SIZE", raising=False)
    monkeypatch.delenv("MEMORY_MAX_BATCH_SIZE", raising=False)

    engine = sensing_server._build_memory_engine("provider/observer")

    assert engine.store.db_path == db_path
    assert engine.model == "provider/observer"
    assert engine.user_name == "the user"
    assert engine.min_batch_size == 5
    assert engine.max_batch_size == 50


def test_build_memory_engine_honors_memory_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("COCO_MEMORY_DB_PATH", str(tmp_path / "memory.db"))
    monkeypatch.setenv("MEMORY_MODEL", "provider/memory")
    monkeypatch.setenv("COCO_USER_NAME", "Ada")
    monkeypatch.setenv("MEMORY_MIN_BATCH_SIZE", "7")
    monkeypatch.setenv("MEMORY_MAX_BATCH_SIZE", "21")

    engine = sensing_server._build_memory_engine("provider/observer")

    assert engine.model == "provider/memory"
    assert engine.user_name == "Ada"
    assert engine.min_batch_size == 7
    assert engine.max_batch_size == 21


@pytest.mark.asyncio
async def test_ai_processor_persists_generated_observation(monkeypatch):
    add_observation = AsyncMock(return_value=True)
    memory_engine = SimpleNamespace(add_observation=add_observation)
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
        memory_engine=memory_engine,
    )
    processor.set_memory_session("session-1")
    processor._build_context_prompt = AsyncMock(return_value="context")
    processor._collect_images = lambda text: (text, [])
    monkeypatch.setattr(
        segment_processor,
        "_observe",
        lambda *_args, **_kwargs: ("generated observation", {}),
    )

    await processor._handle_observation(type="snapshot")

    add_observation.assert_awaited_once()
    persisted = add_observation.await_args.args[0]
    assert persisted.content == "generated observation"
    assert persisted.observation_type == "snapshot"
    assert persisted.session_id == "session-1"
    assert persisted.scenario == "everyday_support"


@pytest.mark.asyncio
async def test_ai_processor_retrieves_context_for_support_event(monkeypatch):
    evidence = SimpleNamespace(
        id="past-observation",
        content='{"observation":"The user handled a similar email."}',
        created_at=100.0,
        observation_type="snapshot",
        session_id="past-session",
    )
    hit = SimpleNamespace(
        proposition=SimpleNamespace(
            id=9,
            text="The recruiter previously asked for an updated end date.",
            confidence=9,
            decay=6,
        ),
        score=0.91,
        observations=[evidence],
    )
    store = SimpleNamespace(search=MagicMock(return_value=[hit]))
    memory_engine = SimpleNamespace(
        store=store,
        add_observation=AsyncMock(return_value=True),
    )
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
        memory_engine=memory_engine,
    )
    queue = processor.subscribe_observations()
    processor._build_context_prompt = AsyncMock(return_value="context")
    processor._collect_images = lambda text: (text, [])
    monkeypatch.setattr(
        segment_processor,
        "_observe",
        lambda *_args, **_kwargs: (
            '{"observation":"The user is drafting a reply in Outlook.",'
            '"user_intent":"Reply to the recruiter",'
            '"rationale":"The detailed questions need a response.",'
            '"need_support":"yes"}',
            {},
        ),
    )

    await processor._handle_observation(type="snapshot")

    event = queue.get_nowait()
    assert event["retrieved_context"]["results"][0]["id"] == 9
    assert event["retrieved_context"]["results"][0]["evidence"]["id"] == (
        "past-observation"
    )
    query = "Reply to the recruiter The user is drafting a reply in Outlook."
    assert event["retrieved_context"]["query"] == query
    store.search.assert_called_once()
    assert store.search.call_args.args == (query,)
    assert store.search.call_args.kwargs["limit"] == 3
    assert store.search.call_args.kwargs["include_observations"] == 1


def test_recent_observations_treats_thumbs_down_as_negative_feedback():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    processor._observation_history.append(
        {
            "ts": time.time(),
            "type": "snapshot",
            "obs": '{"status": "inefficient"}',
            "observation_id": "observation-1",
        }
    )
    processor.record_reaction("observation-1", "thumbs_down")

    block = processor._recent_observations_block()

    assert "user rated the resulting help as NEGATIVE" in block
    assert 'set need_support to "no"' in block


@pytest.mark.asyncio
async def test_everyday_context_keeps_personalized_memory_block():
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: {
            "memory": "Prefer concise help and avoid interrupting normal reading.",
            "conversation_history": ["[2026-08-10 10:00:00] [User]: Help me"],
        },
    )
    http_client = SimpleNamespace(get=AsyncMock(return_value=response))
    processor = AiTutoringProcessor(
        http_client=http_client,
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
        scenario="everyday_support",
    )
    processor.set_session_active(True)

    context = await processor._build_context_prompt()

    assert (
        "<memory>\nPrefer concise help and avoid interrupting normal reading.\n</memory>"
        in context
    )
    assert "<conversation_history>" not in context
    prompt = segment_processor._load_observer_prompt("everyday_support")
    assert "<memory>" in prompt
    assert "</memory>" in prompt


@pytest.mark.asyncio
async def test_everyday_observer_input_omits_user_input(monkeypatch):
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
        scenario="everyday_support",
    )
    processor._build_context_prompt = AsyncMock(
        return_value="<memory>\n(no memory yet)\n</memory>\n\n"
    )
    processor._collect_images = lambda text: (text, [])
    captured = {}

    def fake_observe(text_prompt, *_args, **_kwargs):
        captured["text_prompt"] = text_prompt
        return '{"need_support":"no"}', {}

    monkeypatch.setattr(segment_processor, "_observe", fake_observe)

    await processor._handle_observation(
        type="user_prompt",
        user_text="This should not be included in everyday observer input.",
    )

    assert "<user_input" not in captured["text_prompt"]


@pytest.mark.asyncio
async def test_student_observer_input_keeps_conversation_and_user_input(monkeypatch):
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: {
            "problem_statement": "Solve the exercise",
            "conversation_history": ["[2026-08-10 10:00:00] [User]: My attempt"],
        },
    )
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(get=AsyncMock(return_value=response)),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
        scenario="student_learning",
    )
    processor.set_session_active(True)
    processor._collect_images = lambda text: (text, [])
    captured = {}

    def fake_observe(text_prompt, *_args, **_kwargs):
        captured["text_prompt"] = text_prompt
        return "{}", {}

    monkeypatch.setattr(segment_processor, "_observe", fake_observe)

    await processor._handle_observation(type="user_prompt", user_text="My new attempt")

    assert "<conversation_history>" in captured["text_prompt"]
    assert "[User]: My attempt" in captured["text_prompt"]
    assert "<user_input" in captured["text_prompt"]
    assert "My new attempt" in captured["text_prompt"]
