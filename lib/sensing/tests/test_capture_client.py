import asyncio
import io
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image
from sensing.capture_client import CaptureClient
from sensing.capture_worker import grab_screencapture, serve

MONITOR = {"left": -100, "top": 0, "width": 1, "height": 1}


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_screen_selects_process_isolation_only_on_macos(monkeypatch, platform):
    from sensing import screen as screen_module

    monkeypatch.setattr(screen_module, "_IS_MACOS", platform == "darwin")
    process = MagicMock()
    process.__aenter__ = AsyncMock(return_value=process)
    process.grab = AsyncMock(return_value="process frame")
    process_factory = MagicMock(return_value=process)
    monkeypatch.setattr(screen_module, "CaptureClient", process_factory)
    native = MagicMock()
    native.__enter__.return_value = native
    native.grab.return_value = "threaded frame"
    native_factory = MagicMock(return_value=native)
    monkeypatch.setattr(screen_module.mss, "mss", native_factory)
    screen = screen_module.Screen.__new__(screen_module.Screen)
    screen._capture_client = None

    async def run_in_thread(function, *args):
        return function(*args)

    screen._run_in_thread = AsyncMock(side_effect=run_in_thread)

    async def scenario():
        async with screen._capture_backend() as grab:
            return await grab(MONITOR)

    result = asyncio.run(scenario())
    if platform == "darwin":
        assert result == "process frame"
        process_factory.assert_called_once_with()
        process.grab.assert_awaited_once_with(MONITOR)
        native_factory.assert_not_called()
        screen._run_in_thread.assert_not_awaited()
    else:
        assert result == "threaded frame"
        process_factory.assert_not_called()
        native_factory.assert_called_once_with()
        screen._run_in_thread.assert_awaited_once_with(native.grab, MONITOR)
        native.__exit__.assert_called_once()
        assert screen._capture_client is None


def test_capture_protocol_preserves_pixels_and_reports_errors():
    output = io.BytesIO()
    monitors = []

    def grab(monitor):
        monitors.append(monitor)
        if len(monitors) == 2:
            raise RuntimeError("capture denied")
        return SimpleNamespace(width=1, height=1, bgra=b"\x01\x02\x03\xff")

    line = (json.dumps(MONITOR) + "\n").encode()
    serve(io.BytesIO(line * 2), output, grab)
    output.seek(0)
    assert json.loads(output.readline()) == {"width": 1, "height": 1, "bytes": 4}
    assert output.read(4) == b"\x01\x02\x03\xff"
    assert json.loads(output.readline()) == {"error": "capture denied"}
    assert monitors == [MONITOR, MONITOR]


def helper_command(tmp_path, prelude=""):
    script = tmp_path / "fake_capture.py"
    script.write_text(
        "import json, sys, time\n"
        "from pathlib import Path\n" + prelude + "for line in sys.stdin.buffer:\n"
        "    print(json.dumps({'width': 1, 'height': 1, 'bytes': 4}), flush=True)\n"
        "    sys.stdout.buffer.write(bytes([1, 2, 3, 255]))\n"
        "    sys.stdout.buffer.flush()\n"
    )
    return [sys.executable, str(script)]


@pytest.mark.parametrize("macos_fallback", [False, True])
def test_hung_capture_is_killed_and_next_grab_recovers(tmp_path, macos_fallback):
    marker = tmp_path / "started"
    command = helper_command(
        tmp_path,
        f"marker = Path({str(marker)!r})\n"
        "if not marker.exists():\n"
        "    marker.touch()\n"
        "    time.sleep(60)\n",
    )

    async def scenario():
        async with CaptureClient(timeout=0.5, command=command) as capture:
            capture._macos_fallback = macos_fallback
            with pytest.raises(TimeoutError):
                await capture.grab(MONITOR)
            assert marker.exists()
            assert capture._process is None
            assert capture.timeouts == 1
            assert "timed out" in capture.last_error
            assert capture.backend == ("screencapture" if macos_fallback else "mss")
            frame = await capture.grab(MONITOR)
            assert frame.rgb == bytes([3, 2, 1])
            assert capture.last_error is None
            assert capture.last_success_at is not None
            process = capture._process
            await capture.grab(MONITOR)
            assert capture._process is process  # steady-state helper is reused
            assert capture.starts == 2
        assert process.returncode is not None

    asyncio.run(scenario())


def test_screencapture_fallback_preserves_region_and_logical_dimensions(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        # Simulate Retina backing pixels at twice the logical resolution.
        Image.new("RGB", (2, 2), (11, 22, 33)).save(command[-1])

    monkeypatch.setattr("sensing.capture_worker.subprocess.run", run)
    frame = grab_screencapture(MONITOR)
    assert frame.width == frame.height == 1
    assert frame.rgb == bytes([11, 22, 33])
    command, kwargs = calls[0]
    assert command[command.index("-R") + 1] == "-100,0,1,1"
    assert kwargs["timeout"] == 3


def test_history_status_exposes_each_stage(monkeypatch, tmp_path):
    import time

    from sensing import sensing_server

    timestamp = time.time() - 1
    worker = {"state": "indexing", "stats": {"captured": 7}}
    (tmp_path / "worker-status.json").write_text(json.dumps(worker))
    monkeypatch.setattr(
        sensing_server,
        "screen",
        SimpleNamespace(
            _frame_timestamps={1: str(timestamp)},
            _screen_history=SimpleNamespace(
                index_dir=tmp_path, status=lambda: {"sent_groups": 4}
            ),
            _capture_client=SimpleNamespace(
                status=lambda: {"backend": "screencapture", "timeouts": 1}
            ),
            _task=SimpleNamespace(done=lambda: False),
            _activity_monitor=SimpleNamespace(reason=None),
            is_sensing_paused=lambda: False,
        ),
    )
    result = asyncio.run(sensing_server.screen_history_status())
    assert result["capture"]["backend"] == "screencapture"
    assert result["capture"]["last_frame_at"] == timestamp
    assert 0 <= result["capture"]["frame_age_seconds"] < 5
    assert result["bridge"]["sent_groups"] == 4
    assert result["worker"] == worker


def test_cancelled_capture_releases_process_and_lock(tmp_path):
    command = helper_command(tmp_path, "time.sleep(60)\n")

    async def scenario():
        capture = CaptureClient(command=command)
        task = asyncio.create_task(capture.grab(MONITOR))
        while capture._process is None:
            await asyncio.sleep(0.01)
        process = capture._process
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert capture._process is None
        assert process.returncode is not None
        await capture.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "response",
    [
        b'{"width":1,"height":1,"bytes":999}\n',
        b'{"width":1,"height":1,"bytes":4}\nxx',
        b'{"error":"screen recording permission denied"}\n',
    ],
)
def test_bad_or_incomplete_response_discards_helper(tmp_path, response):
    script = tmp_path / "bad_capture.py"
    script.write_text(
        f"import sys; sys.stdin.buffer.readline(); sys.stdout.buffer.write({response!r})"
    )

    async def scenario():
        async with CaptureClient(command=[sys.executable, str(script)]) as capture:
            with pytest.raises((ValueError, asyncio.IncompleteReadError, RuntimeError)):
                await capture.grab(MONITOR)
            assert capture._process is None
            assert capture.last_error is not None

    asyncio.run(scenario())
