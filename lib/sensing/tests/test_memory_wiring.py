from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

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
    assert 'classify similar observations as "progress"' in block
