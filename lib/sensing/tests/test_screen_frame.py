import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import sensing.screen as screen_module
from PIL import Image
from sensing.screen import Screen


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

    path, _ = asyncio.run(screen._save_frame(frame, "resolution"))

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

    path, _ = asyncio.run(screen._save_frame(frame, "hotkey", lossless=True))

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


def test_monitor_topology_detects_removed_and_rearranged_displays():
    original = [
        {"left": 0, "top": 0, "width": 100, "height": 100},
        {"left": 100, "top": 0, "width": 200, "height": 100},
    ]
    removed = original[:1]
    rearranged = [original[0], {**original[1], "left": -200}]

    assert Screen._monitor_topology(original) != Screen._monitor_topology(removed)
    assert Screen._monitor_topology(original) != Screen._monitor_topology(rearranged)


def test_refresh_monitor_topology_resets_stale_display_state():
    old_monitors = [{"left": 0, "top": 0, "width": 100, "height": 100}]
    new_monitors = [
        {"left": 0, "top": 0, "width": 100, "height": 100},
        {"left": 100, "top": 0, "width": 200, "height": 100},
    ]
    screen = Screen.__new__(Screen)
    screen._frame_lock = asyncio.Lock()
    screen._frames = {1: "stale-frame"}
    screen._mons = old_monitors
    screen._last_active_click_monitor_idx = 1
    screen._pending_event = {"mon": 1}
    debounce_handle = Mock()
    screen._debounce_handle = debounce_handle
    screen._enumerate_monitors = lambda: new_monitors

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline

    monitors, changed = asyncio.run(screen._refresh_monitor_topology(old_monitors))

    assert changed is True
    assert monitors == new_monitors
    assert screen._mons == new_monitors
    assert screen._frames == {}
    assert screen._last_active_click_monitor_idx is None
    assert screen._pending_event is None
    debounce_handle.cancel.assert_called_once_with()
    assert screen._debounce_handle is None


def test_refresh_monitor_topology_preserves_state_when_unchanged():
    monitors = [{"left": -100, "top": 0, "width": 100, "height": 100}]
    screen = Screen.__new__(Screen)
    screen._frame_lock = asyncio.Lock()
    screen._frames = {1: "current-frame"}
    screen._mons = monitors
    screen._last_active_click_monitor_idx = 1
    screen._pending_event = {"mon": 1}
    screen._debounce_handle = None
    screen._enumerate_monitors = lambda: [dict(monitors[0])]

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline

    refreshed, changed = asyncio.run(screen._refresh_monitor_topology(monitors))

    assert changed is False
    assert refreshed is monitors
    assert screen._frames == {1: "current-frame"}
    assert screen._last_active_click_monitor_idx == 1
    assert screen._pending_event == {"mon": 1}


def test_capture_all_monitor_snapshots_labels_one_current_frame_per_display(
    tmp_path, monkeypatch
):
    screen = Screen.__new__(Screen)
    screen.screens_dir = str(tmp_path)
    screen._frame_lock = asyncio.Lock()
    screen._frames = {
        1: SimpleNamespace(width=2, height=1, rgb=bytes([1, 2, 3]) * 2),
        2: SimpleNamespace(width=2, height=1, rgb=bytes([4, 5, 6]) * 2),
    }
    screen._frame_timestamps = {1: "100.10000", 2: "100.20000"}
    screen._mons = [
        {
            "left": 0,
            "top": 0,
            "width": 200,
            "height": 100,
            "display_id": 111,
            "is_primary": True,
        },
        {
            "left": 200,
            "top": 0,
            "width": 300,
            "height": 100,
            "display_id": 222,
            "is_primary": False,
        },
    ]
    screen._last_active_click_monitor_idx = 1
    screen._topology_generation = 3

    async def run_inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    screen._run_in_thread = run_inline

    class FakeController:
        position = (250, 50)

    monkeypatch.setattr(screen_module.mouse, "Controller", FakeController)

    snapshots = asyncio.run(screen.capture_all_monitor_snapshots())

    assert [item.monitor_id for item in snapshots] == [
        "display_id-111",
        "display_id-222",
    ]
    assert [item.timestamp for item in snapshots] == ["100.10000", "100.20000"]
    assert [item.cursor_here for item in snapshots] == [False, True]
    assert [item.last_interaction_here for item in snapshots] == [True, False]
    assert [item.topology_generation for item in snapshots] == [3, 3]
    assert snapshots[0].capture_group_id == snapshots[1].capture_group_id
    assert "monitor-display_id-111_index-1" in snapshots[0].image_path
    assert "monitor-display_id-222_index-2" in snapshots[1].image_path
    assert all(item.image_path.endswith("_current_reference.jpg") for item in snapshots)
