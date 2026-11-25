import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sensing import segment_processor, sensing_server
from sensing.observer_gate import ObserverPaused
from sensing.screen import Screen
from sensing.segment_processor import AiTutoringProcessor
from sensing.streamer import Streamer


@pytest.mark.asyncio
async def test_sleep_cancels_observer_but_preserves_capture_and_indexing(
    monkeypatch, tmp_path
):
    started = asyncio.Event()

    async def observe(*args):
        started.set()
        await asyncio.Event().wait()

    processor = SimpleNamespace(
        generate_observation=AsyncMock(side_effect=observe), close=AsyncMock()
    )
    streamer = Streamer(
        str(tmp_path / "actions.db"), str(tmp_path), segment_processors=[processor]
    )
    screen = Screen.__new__(Screen)
    screen._screen_history = SimpleNamespace(submit=Mock(), stop=AsyncMock())
    screen._task = object()  # Capture task is independent of observer operations.
    capture_task = screen._task
    screen._pending_event = {"type": "click"}
    screen._debounce_handle = Mock()
    pending_flush = screen._debounce_handle
    screen._activity_monitor = SimpleNamespace(paused=False)
    screen._guard = None
    screen.observer_enabled = True
    judge = SimpleNamespace(stop=AsyncMock(), start=AsyncMock())
    monkeypatch.setattr(sensing_server, "screen", screen)
    monkeypatch.setattr(sensing_server, "streamer", streamer)
    monkeypatch.setattr(sensing_server, "progress_detector", judge)

    pending = asyncio.create_task(streamer.generate_observation("snapshot"))
    await started.wait()
    await sensing_server.configure_observer(
        sensing_server.ObserverConfiguration(enabled=False)
    )
    with pytest.raises(ObserverPaused):
        await pending
    with pytest.raises(ObserverPaused):
        await streamer.generate_observation("snapshot")
    processor.generate_observation.assert_awaited_once()
    pending_flush.cancel.assert_called_once()
    assert screen._pending_event is None
    assert screen._task is capture_task
    judge.stop.assert_awaited_once()
    processor.close.assert_not_awaited()

    frame = object()
    screen._publish_history_frames([frame])
    screen._screen_history.submit.assert_called_once_with([frame])
    screen._screen_history.stop.assert_not_awaited()

    await sensing_server.configure_observer(
        sensing_server.ObserverConfiguration(enabled=True)
    )
    processor.generate_observation.side_effect = None
    processor.generate_observation.return_value = ("fresh observation", {})
    assert await streamer.generate_observation("snapshot") == ("fresh observation", {})
    assert screen._task is capture_task
    judge.start.assert_awaited_once()
    screen._screen_history.stop.assert_not_awaited()


@pytest.mark.asyncio
async def test_sleep_gates_periodic_and_idle_processing_without_killing_worker(
    tmp_path,
):
    streamer = Streamer(
        str(tmp_path / "actions.db"), str(tmp_path), check_interval=0.001
    )
    streamer._process_actions_enabled = AsyncMock()
    await streamer.observer_gate.set_enabled(False)
    await streamer.start()
    try:
        await streamer._process_actions_pause("screen.jpg", "123")
        await asyncio.sleep(0.01)
        streamer._process_actions_enabled.assert_not_awaited()
        task = streamer._task
        assert task is not None and not task.done()
        await streamer.observer_gate.set_enabled(True)
        await streamer._process_actions_pause("fresh.jpg", "456")
        streamer._process_actions_enabled.assert_awaited()
        assert streamer._task is task
    finally:
        await streamer.stop()


@pytest.mark.asyncio
async def test_sleep_does_not_override_indexing_off_or_idle_guards(tmp_path):
    screen = Screen.__new__(Screen)
    screen._screen_history = None
    screen._pending_event = None
    screen._debounce_handle = None
    screen._guard = None
    screen._activity_monitor = SimpleNamespace(paused=False)
    screen.set_observer_enabled(False)
    screen._publish_history_frames([object()])
    assert screen._screen_history is None
    screen._screen_history = SimpleNamespace(submit=Mock())
    screen._activity_monitor.paused = True
    screen._publish_history_frames([object()])
    screen._screen_history.submit.assert_not_called()


@pytest.mark.asyncio
async def test_blocking_model_does_not_block_capture_or_publish_after_sleep(
    monkeypatch, tmp_path
):
    started = asyncio.Event()
    released = threading.Event()
    finished = threading.Event()
    loop = asyncio.get_running_loop()

    def observe(*args, **kwargs):
        loop.call_soon_threadsafe(started.set)
        try:
            released.wait(3)
            return "stale observation", {}
        finally:
            finished.set()

    monkeypatch.setattr(segment_processor, "_observe", observe)
    memory = SimpleNamespace(add_observation=AsyncMock())
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://tutor",
        ai_tutor_output_log=str(tmp_path / "observer.log"),
        observer_model="provider/observer",
        memory_engine=memory,
    )
    processor._build_context_prompt = AsyncMock(return_value="context")
    processor._collect_images = lambda text: (text, [])
    streamer = Streamer(
        str(tmp_path / "actions.db"), str(tmp_path), segment_processors=[processor]
    )
    pending = asyncio.create_task(streamer.generate_observation("snapshot"))
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        assert not finished.is_set()
        # The event loop remains available for capture and the sleep endpoint.
        await asyncio.wait_for(streamer.observer_gate.set_enabled(False), timeout=1)
        with pytest.raises(ObserverPaused):
            await pending
    finally:
        released.set()
        await asyncio.to_thread(finished.wait, 3)
    memory.add_observation.assert_not_awaited()
    assert processor._last_observation_id is None
