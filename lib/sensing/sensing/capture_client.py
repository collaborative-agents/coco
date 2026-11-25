"""A restartable native capture process with a bounded request deadline."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

from mss.screenshot import ScreenShot

logger = logging.getLogger(__name__)


class CaptureClient:
    def __init__(self, *, timeout: float = 5.0, command: list[str] | None = None):
        self.timeout = timeout
        self.backend = "mss"
        self._macos_fallback = command is None and sys.platform == "darwin"
        if command is None:
            if getattr(sys, "frozen", False):
                executable = (
                    "screen-capture-worker.exe"
                    if sys.platform == "win32"
                    else "screen-capture-worker"
                )
                command = [str(Path(sys.executable).with_name(executable))]
            else:
                command = [sys.executable, "-m", "sensing.capture_worker"]
        self.command = command
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._closed = False
        self.last_success_at: float | None = None
        self.last_error: str | None = None
        self.timeouts = 0
        self.starts = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def grab(self, monitor: dict) -> ScreenShot:
        async with self._lock:
            if self._closed:
                raise RuntimeError("Screen capture is closed")
            try:
                async with asyncio.timeout(self.timeout):
                    if self._process is None or self._process.returncode is not None:
                        await self._stop_process()
                        self._process = await asyncio.create_subprocess_exec(
                            *self.command,
                            *(
                                ["--backend", self.backend]
                                if self._macos_fallback
                                else []
                            ),
                            stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE,
                            start_new_session=os.name == "posix",
                            # Native-library diagnostics must not pollute the
                            # binary stdout protocol. Inherit sensing's stderr.
                        )
                        self.starts += 1
                    process = self._process
                    geometry = {
                        key: int(monitor[key])
                        for key in ("left", "top", "width", "height")
                    }
                    process.stdin.write((json.dumps(geometry) + "\n").encode())
                    await process.stdin.drain()
                    header = json.loads(await process.stdout.readline())
                    if "error" in header:
                        raise RuntimeError(header["error"])
                    width, height = int(header["width"]), int(header["height"])
                    size = int(header["bytes"])
                    if (
                        width <= 0
                        or height <= 0
                        or size != width * height * 4
                        or size > 256_000_000
                    ):
                        raise ValueError("Invalid screen capture payload size")
                    pixels = await process.stdout.readexactly(size)
                    frame = ScreenShot.from_size(bytearray(pixels), width, height)
                self.last_success_at = time.time()
                self.last_error = None
                return frame
            except BaseException as exc:
                if isinstance(exc, TimeoutError):
                    self.timeouts += 1
                    self.last_error = (
                        f"Native screen capture timed out after {self.timeout}s"
                    )
                    if self._macos_fallback and self.backend == "mss":
                        self.backend = "screencapture"
                        logger.warning(
                            "Switching macOS capture from MSS to screencapture"
                        )
                elif not isinstance(exc, asyncio.CancelledError):
                    self.last_error = str(exc)
                # Cancelling an await cannot cancel a native API in a thread.
                # Killing this helper actually releases its native capture lock.
                await self._stop_process()
                if not isinstance(exc, asyncio.CancelledError):
                    logger.warning(
                        "Screen capture failed; next grab will restart it: %s",
                        self.last_error,
                    )
                raise

    async def _stop_process(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            if process.returncode is None:
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            if process.stdin is not None:
                process.stdin.close()

    async def close(self) -> None:
        self._closed = True
        # A current request has a deadline, including while closing.
        async with self._lock:
            await self._stop_process()

    def status(self) -> dict:
        return {
            "last_success_at": self.last_success_at,
            "last_error": self.last_error,
            "timeouts": self.timeouts,
            "starts": self.starts,
            "pid": self._process.pid if self._process else None,
            "backend": self.backend,
        }
