import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from screen_history.bridge import ScreenHistory
from sensing.screen import Screen


def test_disabling_detaches_and_stops_indexing_before_future_frames(monkeypatch):
    async def scenario():
        screen = Screen.__new__(Screen)
        screen._screen_history_lock = asyncio.Lock()
        old = SimpleNamespace(stop=AsyncMock())
        screen._screen_history = old
        await screen.set_screen_history_enabled(False)
        assert screen._screen_history is None
        old.stop.assert_awaited_once()
        new = SimpleNamespace()
        factory = Mock(return_value=new)
        monkeypatch.setattr(ScreenHistory, "from_env", factory)
        await screen.set_screen_history_enabled(True)
        assert screen._screen_history is new
        factory.assert_called_once_with(enabled=True)

    asyncio.run(scenario())


def test_screen_respects_pause_and_visible_app_guard():
    screen = Screen.__new__(Screen)
    submitted = []
    screen._screen_history = SimpleNamespace(submit=submitted.append)
    screen.is_sensing_paused = lambda: True
    screen._skip = lambda: False
    frames = [object()]
    screen._publish_history_frames(frames)
    screen.is_sensing_paused = lambda: False
    screen._skip = lambda: True
    screen._publish_history_frames(frames)
    assert submitted == []
    screen._skip = lambda: False
    screen._publish_history_frames(frames)
    assert submitted == [frames]
