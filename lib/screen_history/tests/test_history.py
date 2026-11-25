import asyncio
import io
import json
import queue
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from screen_history.bridge import HistoryFrame, ScreenHistory, encode_frames
from screen_history.worker import frame_iterator, read_groups, run


def frame(timestamp=1234.5, monitor="display-A", color=(20, 40, 60)):
    return HistoryFrame(
        SimpleNamespace(width=64, height=32, rgb=bytes(color) * (64 * 32)),
        timestamp,
        monitor,
    )


def test_enabled_by_default_and_command_is_not_shell_parsed(monkeypatch, tmp_path):
    monkeypatch.delenv("COCO_SCREEN_HISTORY_ENABLED", raising=False)
    monkeypatch.delenv("COCO_SCREEN_HISTORY_COMMAND", raising=False)
    assert ScreenHistory.from_env() is not None
    monkeypatch.setenv("COCO_SCREEN_HISTORY_ENABLED", "0")
    assert ScreenHistory.from_env() is None
    monkeypatch.setenv("COCO_SCREEN_HISTORY_ENABLED", "1")
    monkeypatch.setenv("COCO_SCREEN_HISTORY_DIR", str(tmp_path))
    monkeypatch.delenv("COCO_SCREEN_HISTORY_COMMAND", raising=False)
    assert ScreenHistory.from_env().command == [
        sys.executable,
        "-m",
        "screen_history.worker",
    ]
    monkeypatch.setenv(
        "COCO_SCREEN_HISTORY_COMMAND", '["/path with spaces/python", "worker.py"]'
    )
    history = ScreenHistory.from_env()
    assert history.command == ["/path with spaces/python", "worker.py"]
    assert history.index_dir == tmp_path
    assert history.interval == 5


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_frozen_worker_uses_sibling_executable(monkeypatch, tmp_path, platform):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.delenv("COCO_SCREEN_HISTORY_COMMAND", raising=False)
    monkeypatch.setenv("COCO_SCREEN_HISTORY_ENABLED", "0")
    executable = (
        "screen-history-worker.exe"
        if sys.platform == "win32"
        else "screen-history-worker"
    )
    assert ScreenHistory.from_env(enabled=True).command == [
        str(Path(sys.executable).with_name(executable)),
    ]


@pytest.mark.parametrize("interval", [0, -1, float("nan"), float("inf")])
def test_invalid_sampling_interval(interval, tmp_path):
    with pytest.raises(ValueError, match="positive and finite"):
        ScreenHistory(tmp_path, ["python"], interval)


def test_sampling_and_backpressure_keep_only_latest_group(tmp_path):
    async def scenario():
        history = ScreenHistory(tmp_path, [sys.executable])
        history.submit([frame(1)])
        history.submit([frame(2)])  # too soon
        assert history._queue._queue[0][0].timestamp == 1
        history._last_sample -= history.interval
        history.submit([frame(3)])  # replaces the pending sample
        assert history._queue.qsize() == 1
        assert history._queue._queue[0][0].timestamp == 3
        assert history.dropped == 1
        await history.stop()

    asyncio.run(scenario())


def test_roundtrip_owns_images_and_preserves_display_identity(tmp_path):
    pending = queue.Queue()
    ended = threading.Event()
    pending.put(encode_frames([frame(), frame(monitor="display-B")]))
    first = next(frame_iterator(pending, ended, tmp_path))
    assert [item[2] for item in first] == ["display-A", "display-B"]
    assert [item[4] for item in first] == ["1", "2"]
    assert first[0][0].getpixel((0, 0)) == (20, 40, 60)
    assert first[0][1] == 1234.5
    assert first[0][3] is None  # Live persistence: no temporary source path.
    # A restart with the displays in another order keeps their numeric tags.
    pending.put(encode_frames([frame(monitor="display-B"), frame()]))
    second = next(frame_iterator(pending, ended, tmp_path))
    assert [item[4] for item in second] == ["2", "1"]


def test_reader_bounds_startup_backlog_and_reports_eof():
    pending = queue.Queue(maxsize=1)
    ended = threading.Event()
    read_groups(io.BytesIO(b"first\nsecond\nthird\n"), pending, ended)
    assert ended.is_set()
    assert pending.qsize() == 1
    assert pending.get_nowait() == b"third\n"


def test_idle_source_yields_heartbeat_and_eof_stops(tmp_path):
    ended = threading.Event()
    iterator = frame_iterator(queue.Queue(), ended, tmp_path)
    assert next(iterator) is None
    ended.set()
    with pytest.raises(StopIteration):
        next(iterator)


def test_bridge_delivers_frames_to_separate_process_and_stops_on_eof(tmp_path):
    # Real pipe/process lifecycle, without a model or dependency installation.
    receiver = (
        "import pathlib, sys; "
        "root = pathlib.Path(sys.argv[sys.argv.index('--index-dir') + 1]); "
        "[(root / 'received.json').write_bytes(line) for line in sys.stdin.buffer]; "
        "(root / 'eof').touch()"
    )

    async def scenario():
        history = ScreenHistory(tmp_path, [sys.executable, "-c", receiver])
        history.submit([frame()])
        try:
            async with asyncio.timeout(5):
                while not (tmp_path / "received.json").exists():
                    await asyncio.sleep(0.01)
            received = json.loads((tmp_path / "received.json").read_bytes())
            assert received[0]["monitor_id"] == "display-A"
            assert received[0]["timestamp"] == 1234.5
        finally:
            await history.stop()
        assert (tmp_path / "eof").exists()
        assert history._process.returncode == 0

    asyncio.run(scenario())


def test_worker_failure_disables_submission_without_raising_in_sensing(tmp_path):
    async def scenario():
        history = ScreenHistory(tmp_path, [sys.executable, "-c", "raise SystemExit(3)"])
        history.submit([frame()])
        await asyncio.wait_for(history._task, timeout=5)
        assert history._queue.empty()
        history._last_sample -= history.interval
        history.submit([frame(2)])
        assert history._queue.empty()
        status = json.loads((tmp_path / "worker-status.json").read_text())
        assert status["state"] == "error"
        await history.stop()

    asyncio.run(scenario())


def test_worker_uses_package_ingestion_without_real_encoder(tmp_path, monkeypatch):
    """Optional contract check against the installed package or sibling source.

    PYTHONPATH=../streamembed/library/src .venv/bin/pytest ... -k package_ingestion
    """
    import os

    import numpy as np

    se = pytest.importorskip("streamembed")
    import streamembed.api as api

    class Encoder:
        name = "coco-test"
        dim = 4

        def encode_frame(self, image, stream=0):
            return np.array([1, 0, 0, 0], dtype=np.float32), 0

        def encode_query(self, query):
            query_calls.append(query)
            return np.array([1, 0, 0, 0], dtype=np.float32)

    query_calls = []

    monkeypatch.setenv("STREAMEMBED_CONFIG", str(tmp_path / "settings.toml"))
    monkeypatch.delenv("STREAMEMBED_INDEX", raising=False)

    # Fail loudly if any path attempts model resolution/download.
    def refuse_model(*args, **kwargs):
        raise AssertionError("attempted to load real model")

    monkeypatch.setattr(api, "resolve", refuse_model)
    configure = se.configure
    monkeypatch.setattr(
        se, "configure", lambda **kwargs: configure(**kwargs, encoder=Encoder())
    )
    # Keep stdin open until the actual package has persisted both monitors.
    read_fd, write_fd = os.pipe()
    errors = []
    output = io.BytesIO()

    def worker():
        try:
            with os.fdopen(read_fd, "rb") as stream:
                run(tmp_path, stream, output)
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    with os.fdopen(write_fd, "wb", buffering=0) as stream:
        stream.write(encode_frames([frame(1795480000), frame(1795480000, "display-B")]))
        import time

        deadline = time.monotonic() + 5
        rows = []
        while time.monotonic() < deadline and thread.is_alive():
            metadata = tmp_path / "frames.jsonl"
            if metadata.exists():
                rows = metadata.read_text().splitlines()
                if len(rows) == 2:
                    break
            time.sleep(0.01)
        stream.write(
            (
                json.dumps(
                    {
                        "type": "search",
                        "id": "search-1",
                        "arguments": {"query": "the earlier email", "top_k": 2},
                    }
                )
                + "\n"
            ).encode()
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not output.getvalue():
            time.sleep(0.01)
    thread.join(timeout=5)
    try:
        assert not thread.is_alive()
        assert not errors
        assert len(rows) == 2
        response = json.loads(output.getvalue())
        assert response["id"] == "search-1"
        result = response["result"]
        assert result["count"] == 2
        assert len(result["matches"]) == len(result["images"]) == 2
        assert result["images"][0]["mimeType"] == "image/jpeg"
        assert query_calls == ["the earlier email"]
        for row in rows:
            path = tmp_path / json.loads(row)["path"]
            with Image.open(path) as image:
                assert image.size == (64, 32)
        index = api._index()
        assert index.screen(0) != index.screen(1)
        assert len((tmp_path / "vectors.f16").read_bytes()) == 2 * 4 * 2
        assert (
            json.loads((tmp_path / "worker-status.json").read_text())["state"]
            == "stopped"
        )
    finally:
        configure(encoder=Encoder())  # release the test index and global capture


def test_search_correlates_responses_and_preserves_large_image_payloads(tmp_path):
    script = tmp_path / "query_worker.py"
    script.write_text(
        "import json, sys\n"
        "for line in sys.stdin.buffer:\n"
        "    request = json.loads(line)\n"
        "    if isinstance(request, dict):\n"
        "        print(json.dumps({'id': request['id'], 'result': {'query': request['arguments']['query'], 'images': [{'mimeType': 'image/jpeg', 'data': 'a' * 100000}]}}), flush=True)\n"
    )

    async def scenario():
        history = ScreenHistory(tmp_path, [sys.executable, str(script)])
        history.submit([frame()])
        try:
            results = await asyncio.gather(
                history.search({"query": "profile"}),
                history.search({"query": "email"}),
            )
            assert [result["query"] for result in results] == ["profile", "email"]
            assert len(results[0]["images"][0]["data"]) == 100000
            assert history._queries == {}
        finally:
            await history.stop()

    asyncio.run(scenario())
