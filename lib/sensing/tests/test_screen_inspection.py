import asyncio
from unittest.mock import AsyncMock

from sensing.screen import Screen


def _screen(*, frames, active_monitor=None, monitors=None):
    screen = Screen.__new__(Screen)
    screen._frame_lock = asyncio.Lock()
    screen._frames = frames
    screen._last_active_click_monitor_idx = active_monitor
    screen._mons = monitors or []
    screen._save_frame = AsyncMock(return_value=("/tmp/inspect.jpg", "timestamp"))
    return screen


def test_inspect_uses_active_monitor():
    screen = _screen(frames={1: "first", 2: "active"}, active_monitor=2)

    result = asyncio.run(screen._inspect())

    assert result == ("/tmp/inspect.jpg", "timestamp")
    screen._save_frame.assert_awaited_once_with(
        "active", 0, 0, "inspect", draw_box=False
    )


def test_inspect_falls_back_to_cursor_monitor(monkeypatch):
    screen = _screen(
        frames={1: "first", 2: "under-cursor"},
        monitors=[
            {"left": 0, "top": 0, "width": 100, "height": 100},
            {"left": 100, "top": 0, "width": 100, "height": 100},
        ],
    )

    class FakeController:
        position = (150, 50)

    monkeypatch.setattr("sensing.screen.mouse.Controller", FakeController)

    result = asyncio.run(screen._inspect())

    assert result == ("/tmp/inspect.jpg", "timestamp")
    screen._save_frame.assert_awaited_once_with(
        "under-cursor", 0, 0, "inspect", draw_box=False
    )


def test_inspect_returns_empty_before_first_frame():
    screen = _screen(frames={})

    result = asyncio.run(screen._inspect())

    assert result == ("", "")
    screen._save_frame.assert_not_awaited()
