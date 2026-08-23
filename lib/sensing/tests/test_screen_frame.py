import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import sensing.screen as screen_module
from PIL import Image
from sensing.screen import Screen


@pytest.mark.parametrize("position", [(-100, -100), (200, 200)])
def test_save_frame_clamps_cursor_box_to_image(tmp_path, position):
    screen = Screen.__new__(Screen)
    screen.screens_dir = str(tmp_path)

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline
    frame = SimpleNamespace(width=100, height=80, rgb=bytes(100 * 80 * 3))

    path, _ = asyncio.run(screen._save_frame(frame, *position, "outside"))

    with Image.open(path) as saved:
        assert saved.size == (100, 80)


def test_save_frame_preserves_native_resolution(tmp_path):
    screen = Screen.__new__(Screen)
    screen.screens_dir = str(tmp_path)

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline
    frame = SimpleNamespace(
        width=3440,
        height=1440,
        rgb=bytes(3440 * 1440 * 3),
    )

    path, _ = asyncio.run(
        screen._save_frame(
            frame,
            0,
            0,
            "resolution",
            draw_box=False,
        )
    )

    with Image.open(path) as saved:
        assert saved.size == (3440, 1440)


def test_save_frame_uses_lossless_png_for_hotkey_capture(tmp_path):
    screen = Screen.__new__(Screen)
    screen.screens_dir = str(tmp_path)

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline
    frame = SimpleNamespace(
        width=120,
        height=80,
        rgb=bytes([13, 127, 241]) * (120 * 80),
    )

    path, _ = asyncio.run(
        screen._save_frame(
            frame,
            0,
            0,
            "hotkey",
            draw_box=False,
            lossless=True,
        )
    )

    assert path.endswith("_hotkey.png")
    with Image.open(path) as saved:
        assert saved.format == "PNG"
        assert saved.size == (120, 80)
        assert saved.getpixel((0, 0)) == (13, 127, 241)


def test_hotkey_prefers_fresh_native_macos_capture(tmp_path, monkeypatch):
    screen = Screen.__new__(Screen)
    screen._hotkey_dir = str(tmp_path)
    screen._on_hotkey_callback = None
    screen._note_user_activity = lambda: None
    screen._save_frame = AsyncMock()

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline

    class FakeController:
        position = (250, 125)

    captured = {}

    def save_native(x, y, path):
        captured.update(x=x, y=y, path=path)
        return True

    monkeypatch.setattr(screen_module, "_IS_MACOS", True)
    monkeypatch.setattr(screen_module.mouse, "Controller", FakeController)
    monkeypatch.setattr(screen_module, "_save_native_display_at_point", save_native)

    path, timestamp = asyncio.run(screen.capture_for_hotkey())

    assert captured["x"] == 250
    assert captured["y"] == 125
    assert captured["path"] == path
    assert path == str(tmp_path / f"{timestamp}_hotkey.png")
    screen._save_frame.assert_not_awaited()


def test_mon_for_returns_none_outside_all_monitors():
    monitors = [
        {"left": 0, "top": 0, "width": 100, "height": 100},
        {"left": 200, "top": 0, "width": 100, "height": 100},
    ]

    assert Screen._mon_for(50, 50, monitors) == 1
    assert Screen._mon_for(250, 50, monitors) == 2
    assert Screen._mon_for(150, 50, monitors) is None
    assert Screen._mon_for(-1, 50, monitors) is None
