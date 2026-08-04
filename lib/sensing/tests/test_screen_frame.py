import asyncio
from types import SimpleNamespace

import pytest
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


def test_mon_for_returns_none_outside_all_monitors():
    monitors = [
        {"left": 0, "top": 0, "width": 100, "height": 100},
        {"left": 200, "top": 0, "width": 100, "height": 100},
    ]

    assert Screen._mon_for(50, 50, monitors) == 1
    assert Screen._mon_for(250, 50, monitors) == 2
    assert Screen._mon_for(150, 50, monitors) is None
    assert Screen._mon_for(-1, 50, monitors) is None
