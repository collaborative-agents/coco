"""Bounded bridge from externally supplied frames to an isolated StreamEmbed worker.

Torch/transformers are loaded only in the worker process. The worker receives
owned images rather than paths into sensing's short-lived screenshot directory.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import math
import os
import signal
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from memory.paths import default_memory_db_path
from PIL import Image

from screen_history.status import write_status

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HistoryFrame:
    frame: Any  # An owned mss ScreenShot, never a mutable capture buffer.
    timestamp: float
    monitor_id: str


def encode_frames(frames: list[HistoryFrame]) -> bytes:
    """Encode one capture group outside the sensing event loop."""
    images = []
    for item in frames:
        frame = item.frame
        image = Image.frombytes("RGB", (frame.width, frame.height), frame.rgb)
        # Bound pipe traffic and worker memory; preserve small images as-is.
        if image.width > 1280:
            image = image.resize(
                (1280, max(1, image.height * 1280 // image.width)),
                Image.Resampling.LANCZOS,
            )
        with io.BytesIO() as buffer:
            image.save(buffer, "PNG", compress_level=1)
            images.append(
                {
                    "timestamp": item.timestamp,
                    "monitor_id": item.monitor_id,
                    "png": base64.b64encode(buffer.getvalue()).decode("ascii"),
                }
            )
    return (json.dumps(images, separators=(",", ":")) + "\n").encode("ascii")


class ScreenHistory:
    """A sampled producer; a slow or failed indexer never blocks capture."""

    def __init__(self, index_dir: Path, command: list[str], interval: float = 5.0):
        if not math.isfinite(interval) or interval <= 0:
            raise ValueError("COCO_SCREEN_HISTORY_INTERVAL must be positive and finite")
        if not command or not all(isinstance(arg, str) and arg for arg in command):
            raise ValueError(
                "COCO_SCREEN_HISTORY_COMMAND must be a nonempty JSON string array"
            )
        self.index_dir = index_dir.expanduser().resolve()
        self.command = command
        self.interval = interval
        self._queue: asyncio.Queue[list[HistoryFrame]] = asyncio.Queue(maxsize=1)
        self._last_sample = float("-inf")
        self._task: asyncio.Task | None = None
        self._process: asyncio.subprocess.Process | None = None
        self.dropped = 0
        self.sampled_groups = 0
        self.sent_groups = 0
        self.last_sample_at: float | None = None
        self.last_sent_at: float | None = None
        self._started = asyncio.Event()
        self._write_lock = asyncio.Lock()
        self._queries: dict[str, asyncio.Future] = {}

    async def _write(self, payload: bytes) -> None:
        async with self._write_lock:
            if self._process is None or self._process.returncode is not None:
                raise RuntimeError("Screen history worker is not running")
            self._process.stdin.write(payload)
            await self._process.stdin.drain()

    async def search(self, arguments: dict) -> dict:
        if self._task is None or self._task.done():
            return {
                "error": "Screen history is not ready; wait for sensing to capture a frame"
            }
        if len(self._queries) >= 4:
            return {"error": "Screen history search is busy; retry shortly"}
        request_id = uuid.uuid4().hex
        try:
            async with asyncio.timeout(90):
                await self._started.wait()
                if self._task.done():
                    return {
                        "error": "Screen history worker is unavailable; restart sensing"
                    }
                future = asyncio.get_running_loop().create_future()
                self._queries[request_id] = future
                await self._write(
                    (
                        json.dumps(
                            {"type": "search", "id": request_id, "arguments": arguments}
                        )
                        + "\n"
                    ).encode()
                )
                return await future
        except TimeoutError:
            return {
                "error": "Screen history search timed out; the local model may still be loading"
            }
        except (OSError, RuntimeError) as exc:
            return {"error": f"Screen history search unavailable: {exc}"}
        finally:
            self._queries.pop(request_id, None)

    async def _read_responses(self, stream) -> None:
        async for line in stream:
            try:
                response = json.loads(line)
            except ValueError:
                logger.warning("Ignoring non-protocol screen history worker output")
                continue
            future = self._queries.get(response.get("id"))
            if future is not None and not future.done():
                future.set_result(
                    response.get("result")
                    or {"error": response.get("error", "Invalid worker response")}
                )

    @classmethod
    def from_env(cls, *, enabled: bool | None = None) -> ScreenHistory | None:
        if enabled is None:
            enabled = os.environ.get(
                "COCO_SCREEN_HISTORY_ENABLED", "1"
            ).strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        if not enabled:
            return None
        raw_command = os.environ.get("COCO_SCREEN_HISTORY_COMMAND")
        if raw_command:
            command = json.loads(raw_command)
            if not isinstance(command, list):
                raise ValueError(
                    "COCO_SCREEN_HISTORY_COMMAND must be a JSON string array"
                )
        elif getattr(sys, "frozen", False):
            executable = (
                "screen-history-worker.exe"
                if sys.platform == "win32"
                else "screen-history-worker"
            )
            command = [str(Path(sys.executable).with_name(executable))]
        else:
            command = [sys.executable, "-m", "screen_history.worker"]
        return cls(
            Path(
                os.environ.get(
                    "COCO_SCREEN_HISTORY_DIR",
                    str(default_memory_db_path().parent.parent / "screen-history"),
                )
            ),
            command,
            float(os.environ.get("COCO_SCREEN_HISTORY_INTERVAL", "5")),
        )

    def submit(self, frames: list[HistoryFrame]) -> None:
        """Called on the sensing loop with fresh frames, after capture guards."""
        if not frames or (self._task is not None and self._task.done()):
            return
        now = time.monotonic()
        if now - self._last_sample < self.interval:
            return
        self._last_sample = now
        self.sampled_groups += 1
        self.last_sample_at = max(frame.timestamp for frame in frames)
        if self._queue.full():
            self._queue.get_nowait()
            self.dropped += 1
        self._queue.put_nowait(frames)
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        failure = None
        responses = None
        try:
            self.index_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.index_dir.chmod(0o700)
            write_status(self.index_dir, "loading", {})
            log_path = self.index_dir / "worker.log"
            with log_path.open("ab") as log:
                log_path.chmod(0o600)
                self._process = await asyncio.create_subprocess_exec(
                    *self.command,
                    "--index-dir",
                    str(self.index_dir),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=log,
                    limit=16 * 1024 * 1024,
                    start_new_session=os.name == "posix",
                )
            responses = asyncio.create_task(self._read_responses(self._process.stdout))
            self._started.set()
            logger.info("Screen history worker started; index: %s", self.index_dir)
            while self._process.returncode is None:
                if responses.done():
                    responses.result()
                    raise RuntimeError("Screen history worker response channel closed")
                try:
                    frames = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                except TimeoutError:
                    continue
                payload = await asyncio.to_thread(encode_frames, frames)
                await self._write(payload)
                self.sent_groups += 1
                self.last_sent_at = time.time()
            raise RuntimeError(f"worker exited with code {self._process.returncode}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = str(exc)
            logger.exception("Screen history indexing disabled for this run")
        finally:
            self._started.set()
            await self._stop_process()
            if responses is not None:
                responses.cancel()
                await asyncio.gather(responses, return_exceptions=True)
            for future in self._queries.values():
                if not future.done():
                    future.set_result({"error": "Screen history worker stopped"})
            while not self._queue.empty():
                self._queue.get_nowait()
            try:
                status_path = self.index_dir / "worker-status.json"
                status = (
                    json.loads(status_path.read_text()) if status_path.exists() else {}
                )
                if status.get("state") != "error":
                    write_status(
                        self.index_dir,
                        "error" if failure else "stopped",
                        status.get("stats", {}),
                        failure,
                    )
            except Exception:
                logger.exception("Could not write final screen history status")

    async def _stop_process(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None and not process.stdin.is_closing():
            # abort also releases a write blocked behind a slow model load.
            process.stdin.transport.abort()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            await self._signal_process(signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                await self._signal_process(
                    signal.SIGKILL if os.name == "posix" else signal.SIGTERM
                )
                await process.wait()

    async def _signal_process(self, sig: int) -> None:
        process = self._process
        if process is None or process.returncode is not None:
            return
        try:
            if os.name == "posix":
                # Stop the whole worker group, including children of custom commands.
                os.killpg(process.pid, sig)
            else:
                # Terminate the worker and any children together on Windows too.
                killer = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await killer.wait()
        except ProcessLookupError:
            pass

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    def status(self) -> dict:
        return {
            "sampled_groups": self.sampled_groups,
            "sent_groups": self.sent_groups,
            "dropped_groups": self.dropped,
            "pending_groups": self._queue.qsize(),
            "last_sample_at": self.last_sample_at,
            "last_sent_at": self.last_sent_at,
            "running": self._task is not None and not self._task.done(),
            "index_dir": str(self.index_dir),
        }
