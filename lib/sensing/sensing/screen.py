"""Modified from https://github.com/GeneralUserModels/gum/blob/main/gum/observers/screen.py"""

from __future__ import annotations

import asyncio
import gc
import logging
import os
import time
from collections import deque
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

import platform
import sys

import mss
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from pynput import keyboard, mouse  # still synchronous
from sensing.observer import Observer

_IS_MACOS = sys.platform == "darwin"

if _IS_MACOS:
    import Quartz
    from shapely.geometry import box
    from shapely.ops import unary_union


class Update(BaseModel):
    content: str = Field(..., description="The content of the update")
    content_type: Literal["input_text", "input_image"] = Field(
        ..., description="The type of the update"
    )


###############################################################################
# Window‑geometry helpers (macOS only via Quartz; no-op on other platforms)   #
###############################################################################


if _IS_MACOS:

    def _get_global_bounds() -> tuple[float, float, float, float]:
        """Return a bounding box enclosing **all** physical displays.

        Returns
        -------
        (min_x, min_y, max_x, max_y) tuple in Quartz global coordinates.
        """
        err, ids, cnt = Quartz.CGGetActiveDisplayList(16, None, None)  # type: ignore
        if err != Quartz.kCGErrorSuccess:  # type: ignore
            raise OSError(f"CGGetActiveDisplayList failed: {err}")

        min_x = min_y = float("inf")
        max_x = max_y = -float("inf")
        for did in ids[:cnt]:
            r = Quartz.CGDisplayBounds(did)  # type: ignore
            x0, y0 = r.origin.x, r.origin.y
            x1, y1 = x0 + r.size.width, y0 + r.size.height
            min_x, min_y = min(min_x, x0), min(min_y, y0)
            max_x, max_y = max(max_x, x1), max(max_y, y1)
        return min_x, min_y, max_x, max_y

    def _get_visible_windows() -> list[tuple[dict, float]]:
        """List *onscreen* windows with their visible‑area ratio.

        Each tuple is ``(window_info_dict, visible_ratio)`` where *visible_ratio*
        is in ``[0.0, 1.0]``.  Internal system windows (Dock, WindowServer, …) are
        ignored.
        """
        _, _, _, gmax_y = _get_global_bounds()

        opts = (
            Quartz.kCGWindowListOptionOnScreenOnly  # type: ignore
            | Quartz.kCGWindowListOptionIncludingWindow  # type: ignore
        )
        wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID)  # type: ignore

        occupied = None  # running union of opaque regions above the current window
        result: list[tuple[dict, float]] = []

        for info in wins:
            owner = info.get("kCGWindowOwnerName", "")
            if owner in ("Dock", "WindowServer", "Window Server"):
                continue

            bounds = info.get("kCGWindowBounds", {})
            x, y, w, h = (
                bounds.get("X", 0),
                bounds.get("Y", 0),
                bounds.get("Width", 0),
                bounds.get("Height", 0),
            )
            if w <= 0 or h <= 0:
                continue  # hidden or minimised

            inv_y = gmax_y - y - h  # Quartz→Shapely Y‑flip
            poly = box(x, inv_y, x + w, inv_y + h)
            if poly.is_empty:
                continue

            visible = poly if occupied is None else poly.difference(occupied)
            if not visible.is_empty:
                ratio = visible.area / poly.area
                result.append((info, ratio))
                occupied = poly if occupied is None else unary_union([occupied, poly])

        return result

    def _is_app_visible(names: Iterable[str]) -> bool:
        """Return *True* if **any** window from *names* is at least partially visible."""
        targets = set(names)
        return any(
            info.get("kCGWindowOwnerName", "") in targets and ratio > 0
            for info, ratio in _get_visible_windows()
        )

else:

    def _is_app_visible(names: Iterable[str]) -> bool:  # type: ignore[misc]
        """Non-macOS stub: window visibility detection not available."""
        return False


###############################################################################
# Screen observer                                                             #
###############################################################################


class Screen(Observer):
    """
    Capture before/after screenshots around user interactions.
    Blocking work (Quartz, mss, Pillow, OpenAI Vision) is executed in
    background threads via `asyncio.to_thread`.

    Keyboard events are optimized to save disk space:
    - Only the first and last screenshots are kept for consecutive key presses
    - Intermediate screenshots are automatically deleted
    - A keyboard session ends after `keyboard_timeout` seconds of inactivity
    """

    _CAPTURE_FPS: int = 5  # Reduced from 10 to 5 to reduce memory pressure
    _PERIODIC_SEC: int = 30
    _DEBOUNCE_SEC: float = 2.0
    _MON_START: int = 1  # first real display in mss
    _MEMORY_CLEANUP_INTERVAL: int = 30  # Force GC every 30 frames instead of 50
    _MAX_WORKERS: int = 4  # Limit thread pool size to prevent exhaustion

    # Scroll filtering constants
    _SCROLL_DEBOUNCE_SEC: float = 0.8  # Minimum time between scroll events
    _SCROLL_MIN_DISTANCE: float = 8.0  # Minimum scroll distance to log
    _SCROLL_MAX_FREQUENCY: int = 8  # Max scroll events per second
    _SCROLL_SESSION_TIMEOUT: float = 3.0  # Timeout for scroll sessions

    # ─────────────────────────────── construction
    def __init__(
        self,
        screenshots_dir: str = "~/Downloads/coco-records/screenshots",
        hotkey_captures_dir: str | None = None,
        skip_when_visible: str | list[str] | None = None,
        history_k: int = 10,
        debug: bool = False,
        keyboard_timeout: float = 2.0,
        gdrive_dir: str = "screenshots",
        client_secrets_path: str = "~/Desktop/client_secrets.json",
        scroll_debounce_sec: float = 0.5,
        scroll_min_distance: float = 5.0,
        scroll_max_frequency: int = 10,
        scroll_session_timeout: float = 2.0,
        enable_global_hotkey: bool = False,
    ) -> None:
        self.screens_dir = os.path.abspath(os.path.expanduser(screenshots_dir))
        os.makedirs(self.screens_dir, exist_ok=True)

        # Hot-key capture directory: sibling of screenshots_dir by default.
        if hotkey_captures_dir is not None:
            self._hotkey_dir = os.path.abspath(os.path.expanduser(hotkey_captures_dir))
        else:
            self._hotkey_dir = os.path.join(
                os.path.dirname(self.screens_dir), "hotkey_captures"
            )
        os.makedirs(self._hotkey_dir, exist_ok=True)

        self._guard = (
            {skip_when_visible}
            if isinstance(skip_when_visible, str)
            else set(skip_when_visible or [])
        )

        self.debug = debug

        # Custom thread pool to prevent exhaustion
        self._thread_pool = ThreadPoolExecutor(max_workers=self._MAX_WORKERS)

        # Scroll filtering configuration
        self._scroll_debounce_sec = scroll_debounce_sec
        self._scroll_min_distance = scroll_min_distance
        self._scroll_max_frequency = scroll_max_frequency
        self._scroll_session_timeout = scroll_session_timeout

        # state shared with worker
        self._frames: dict[int, Any] = {}
        self._frame_lock = asyncio.Lock()

        self._history: deque[str] = deque(maxlen=max(0, history_k))
        self._pending_event: dict | None = None
        self._debounce_handle: asyncio.TimerHandle | None = None

        # keyboard activity tracking
        self._key_activity_start: float | None = None
        self._key_activity_timeout: float = (
            keyboard_timeout  # seconds of inactivity to consider session ended
        )
        self._key_screenshots: list[
            str
        ] = []  # track intermediate screenshots for cleanup
        self._key_activity_lock = asyncio.Lock()

        # scroll activity tracking
        self._scroll_last_time: float | None = None
        self._scroll_last_position: tuple[float, float] | None = None
        self._scroll_session_start: float | None = None
        self._scroll_event_count: int = 0
        self._scroll_lock = asyncio.Lock()

        # last_active_click_time
        self._last_active_click_time: float = time.time()
        self._last_active_click_monitor_idx: int | None = None
        self._idle_triggered: bool = False
        self._idle_timeout: float = 60.0
        self._on_idle_callback = None
        self._on_user_prompt_callback = None
        self._on_hotkey_callback = None
        self._enable_global_hotkey = enable_global_hotkey

        # Monitor list populated once the _worker starts mss — used by
        # capture_for_hotkey() to determine which monitor is under the cursor.
        self._mons: list[dict] = []

        # call parent
        super().__init__()

        # Adjust settings for high-DPI displays
        if self._detect_high_dpi():
            self._CAPTURE_FPS = 3  # Even lower FPS for high-DPI displays
            self._MEMORY_CLEANUP_INTERVAL = 20  # More frequent cleanup
            if self.debug:
                logging.getLogger("Screen").info(
                    "High-DPI display detected, using conservative settings"
                )

    def set_idle_timeout(self, timeout_seconds: float) -> None:
        """Update the idle timeout at runtime (e.g. from a session config request)."""
        self._idle_timeout = timeout_seconds
        # Reset idle state so the new timeout takes effect from now
        self._idle_triggered = False

    def reset_idle_timer(self) -> None:
        """Reset the idle timer as if the user just interacted.

        Called when guidance is delivered so the pause detector doesn't
        immediately re-fire before the student has time to absorb the hint.
        """
        self._last_active_click_time = time.time()
        self._idle_triggered = False

    def register_on_idle(self, callback):
        """Register a callback to be called when idle is detected."""
        self._on_idle_callback = callback

    def register_on_user_prompt(self, callback):
        """Register a callback to be called when a user prompt is received."""
        self._on_user_prompt_callback = callback

    def register_on_hotkey(self, callback) -> None:
        """Register an async callback invoked after each hot-key capture.

        The callback receives ``(image_path: str, timestamp: str)`` keyword args.
        """
        self._on_hotkey_callback = callback

    async def _handle_user_prompt(self, user_text: str) -> None:
        """Handle a user prompt event."""
        image_path, timestamp = await self._inspect()
        if self._on_user_prompt_callback:
            asyncio.create_task(
                self._on_user_prompt_callback(
                    user_text=user_text,
                    image_path=image_path,
                    timestamp=timestamp,
                )
            )

    @staticmethod
    def _mon_for(x: float, y: float, mons: list[dict]) -> int:
        for idx, m in enumerate(mons, 1):
            if (
                m["left"] <= x < m["left"] + m["width"]
                and m["top"] <= y < m["top"] + m["height"]
            ):
                return idx
        return idx

    async def _run_in_thread(self, func, *args, **kwargs):
        """Run a function in the custom thread pool."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._thread_pool, lambda: func(*args, **kwargs)
        )

    def _detect_high_dpi(self) -> bool:
        """Detect if running on a high-DPI display and adjust settings."""
        try:
            # Check if any monitor has high resolution (likely Retina)
            with mss.mss() as sct:
                for monitor in sct.monitors[1:]:  # Skip monitor 0 (all monitors)
                    if monitor["width"] > 2560 or monitor["height"] > 1600:
                        return True
        except Exception:
            pass
        return False

    def _should_log_scroll(self, x: float, y: float, dx: float, dy: float) -> bool:
        """
        Determine if a scroll event should be logged based on filtering criteria.

        Returns True if the scroll event should be logged, False otherwise.
        """
        current_time = time.time()

        # Check if this is a new scroll session
        if (
            self._scroll_session_start is None
            or current_time - self._scroll_session_start > self._scroll_session_timeout
        ):
            # Start new session
            self._scroll_session_start = current_time
            self._scroll_event_count = 0
            self._scroll_last_position = (x, y)
            self._scroll_last_time = current_time
            return True

        # Check debounce time
        if (
            self._scroll_last_time is not None
            and current_time - self._scroll_last_time < self._scroll_debounce_sec
        ):
            return False

        # Check minimum distance
        if self._scroll_last_position is not None:
            distance = (
                (x - self._scroll_last_position[0]) ** 2
                + (y - self._scroll_last_position[1]) ** 2
            ) ** 0.5
            if distance < self._scroll_min_distance:
                return False

        # Check frequency limit
        self._scroll_event_count += 1
        session_duration = current_time - self._scroll_session_start
        if session_duration > 0:
            frequency = self._scroll_event_count / session_duration
            if frequency > self._scroll_max_frequency:
                return False

        # Update tracking state
        self._scroll_last_position = (x, y)
        self._scroll_last_time = current_time

        return True

    async def _cleanup_key_screenshots(self) -> None:
        """Clean up intermediate keyboard screenshots, keeping only first and last."""
        if len(self._key_screenshots) <= 2:
            return

        # Keep first and last, delete the rest
        to_delete = self._key_screenshots[1:-1]
        self._key_screenshots = [self._key_screenshots[0], self._key_screenshots[-1]]

        for path in to_delete:
            try:
                await self._run_in_thread(os.remove, path)
                if self.debug:
                    logging.getLogger("Screen").info(
                        f"Deleted intermediate screenshot: {path}"
                    )
            except OSError:
                pass  # File might already be deleted

    # Maximum dimension (width or height) for saved screenshots.  The
    # observer model works fine at reduced resolution and smaller files
    # save disk space, memory, and base64-encoding time.
    _SCREENSHOT_MAX_DIM: int = 1280

    # ─────────────────────────────── I/O helpers
    async def _save_frame(
        self,
        frame,
        x,
        y,
        tag: str,
        box_color: str = "red",
        box_width: int = 10,
        draw_box: bool = True,
        target_dir: str | None = None,
    ) -> tuple[str, str]:
        # print(f"[SAVE FRAME] saving frame for tag: {tag}")
        ts = f"{time.time():.5f}"
        save_dir = target_dir if target_dir is not None else self.screens_dir
        path = os.path.join(save_dir, f"{ts}_{tag}.jpg")
        image = Image.frombytes("RGB", (frame.width, frame.height), frame.rgb)

        # Draw the cursor box at original coordinates before any resize
        if draw_box:
            draw = ImageDraw.Draw(image)
            x1, x2 = max(0, x - 30), min(frame.width, x + 30)
            y1, y2 = max(0, y - 20), min(frame.height, y + 20)
            draw.rectangle([x1, y1, x2, y2], outline=box_color, width=box_width)
            del draw

        # Downscale to save disk space and reduce base64 payload for the
        # observer model.  Aspect ratio is preserved; images already within
        # the limit are left untouched.
        w, h = image.size
        max_dim = self._SCREENSHOT_MAX_DIM
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            new_w = int(w * scale)
            new_h = int(h * scale)
            _resample = getattr(Image, "LANCZOS", None) or getattr(
                Image, "ANTIALIAS", 1
            )
            image = image.resize((new_w, new_h), _resample)

        # Save with lower quality to reduce memory usage
        await self._run_in_thread(
            image.save,
            path,
            "JPEG",
            quality=70,
            optimize=True,
        )

        # Explicitly delete image object to free memory
        del image
        # print(f"[SAVE FRAME] saved frame to path: {path}")
        return path, ts

    async def _process_and_emit(
        self,
        before_path: str,
        after_path: str,
        action: str,
        ev: dict,
    ) -> None:
        if "scroll" in action:
            # Include scroll delta information
            scroll_info = ev.get("scroll", (0, 0))
            step = f"scroll({ev['position'][0]:.1f}, {ev['position'][1]:.1f}, dx={scroll_info[0]:.2f}, dy={scroll_info[1]:.2f})"
            await self.update_queue.put(Update(content=step, content_type="input_text"))
        elif "click" in action:
            step = f"{action}({ev['position'][0]:.1f}, {ev['position'][1]:.1f})"
            await self.update_queue.put(Update(content=step, content_type="input_text"))
        else:
            step = f"{action}({ev['text']})"
            await self.update_queue.put(Update(content=step, content_type="input_text"))

    async def stop(self) -> None:
        """Stop the observer and clean up resources."""
        await super().stop()

        # Clean up frame objects
        async with self._frame_lock:
            for frame in self._frames.values():
                if frame is not None:
                    del frame
            self._frames.clear()

        # Force garbage collection
        await self._run_in_thread(gc.collect)

        # Shutdown thread pool
        if hasattr(self, "_thread_pool"):
            self._thread_pool.shutdown(wait=True)

    # ─────────────────────────────── skip guard
    def _skip(self) -> bool:
        return _is_app_visible(self._guard) if self._guard else False

    # ─────────────────────────────── inspect current frame screenshot
    async def _inspect(self) -> tuple[str, str]:
        """Capture current screen and return path."""
        async with self._frame_lock:
            if self._last_active_click_monitor_idx is None:
                raise RuntimeError("No active monitor found for inspection.")
            bf = self._frames[self._last_active_click_monitor_idx]
            if bf is None:
                return "", ""
            path, ts = await self._save_frame(bf, 0, 0, "inspect", draw_box=False)
            print(f"[INSPECT] saved current frame to: {path} at {ts}")
            return path, ts

    async def capture_for_hotkey(self) -> tuple[str, str]:
        """Capture the monitor currently under the cursor and save to hotkey dir.

        Uses the cursor's live position (not the last-click monitor) so the
        capture always reflects the display the user is actively looking at
        when they press Cmd+Shift+H.

        Returns ``(image_path, timestamp)`` on success, ``("", "")`` on failure.
        """
        # Get cursor position synchronously — mouse.Controller().position is fast.
        x, y = mouse.Controller().position

        async with self._frame_lock:
            if self._mons:
                idx = self._mon_for(x, y, self._mons)
            elif self._last_active_click_monitor_idx is not None:
                idx = self._last_active_click_monitor_idx
            else:
                return "", ""

            frame = self._frames.get(idx)
            if frame is None:
                return "", ""

            path, ts = await self._save_frame(
                frame, 0, 0, "hotkey", draw_box=False, target_dir=self._hotkey_dir
            )

        print(f"[HOTKEY CAPTURE] saved to: {path} at {ts}")

        if self._on_hotkey_callback:
            asyncio.create_task(self._on_hotkey_callback(image_path=path, timestamp=ts))

        return path, ts

    # ─────────────────────────────── get last active click time
    def get_last_active_click_time(self) -> float:
        return self._last_active_click_time

    # ─────────────────────────────── main async worker
    async def _worker(self) -> None:  # overrides base class
        log = logging.getLogger("Screen")
        if self.debug:
            logging.basicConfig(
                level=logging.INFO,
                format="%(asctime)s [Screen] %(message)s",
                datefmt="%H:%M:%S",
            )
        else:
            log.addHandler(logging.NullHandler())
            log.propagate = False

        CAP_FPS = self._CAPTURE_FPS

        loop = asyncio.get_running_loop()

        # ------------------------------------------------------------------
        # All calls to mss / Quartz are wrapped in `to_thread`
        # ------------------------------------------------------------------
        with mss.mss() as sct:
            mons = sct.monitors[self._MON_START :]
            # Expose monitor list so capture_for_hotkey() can resolve cursor position.
            self._mons = mons

            # ---- mouse callbacks (pynput is sync → schedule into loop) ----
            def schedule_event(x: float, y: float, typ: str):
                asyncio.run_coroutine_threadsafe(mouse_event(x, y, typ), loop)

            def schedule_scroll_event(x: float, y: float, dx: float, dy: float):
                asyncio.run_coroutine_threadsafe(scroll_event(x, y, dx, dy), loop)

            def schedule_key_event(key, typ: str):
                asyncio.run_coroutine_threadsafe(key_event(key, typ), loop)

            # ---- Cmd+Shift+H global hot-key --------------------------------
            # GlobalHotKeys uses CGEventTap on macOS, which requires Input
            # Monitoring permission. If that permission is missing, macOS sends
            # SIGKILL to the process — a Python try/except cannot catch this.
            # Disabled by default; use POST /hotkey/capture as the safe fallback.
            hotkey_listener = None
            if self._enable_global_hotkey:
                try:

                    def _on_hotkey_press():
                        asyncio.run_coroutine_threadsafe(
                            self.capture_for_hotkey(), loop
                        )

                    hotkey_listener = keyboard.GlobalHotKeys(
                        {"<cmd>+<shift>+<space>": _on_hotkey_press}
                    )
                    hotkey_listener.start()
                    log.info("Hot-key listener started (Cmd+Shift+Space)")
                except Exception as exc:
                    log.warning(
                        f"Could not start hot-key listener: {exc}. "
                        "Use POST /hotkey/capture as a fallback."
                    )
            else:
                log.info(
                    "Global hot-key listener disabled (enable_global_hotkey=False). "
                    "Use POST /hotkey/capture to trigger captures."
                )
            # ----------------------------------------------------------------

            mouse_listener = mouse.Listener(
                on_click=lambda x, y, btn, prs: schedule_event(
                    x, y, f"click_{btn.name}"
                )
                if prs
                else None,
                on_scroll=lambda x, y, dx, dy: schedule_scroll_event(x, y, dx, dy),
            )
            key_listener = keyboard.Listener(
                on_press=lambda key: schedule_key_event(key, "press"),
            )
            mouse_listener.start()
            key_listener.start()

            # ---- nested helper inside the async context ----
            async def flush():
                if self._pending_event is None:
                    return
                if self._skip():
                    self._pending_event = None
                    return

                ev = self._pending_event
                print(
                    # f"[FLUSH] [{ev['eid']}] processing event: {ev['type']} at {ev['position']} on monitor {ev['mon']}"
                )
                try:
                    aft = await self._run_in_thread(sct.grab, mons[ev["mon"] - 1])
                except Exception as e:
                    # print(f"[FLUSH] [{ev['eid']}] failed to capture after frame: {e}")
                    if self.debug:
                        logging.getLogger("Screen").error(
                            f"Failed to capture after frame: {e}"
                        )
                    self._pending_event = None
                    return

                if "scroll" in ev["type"]:
                    scroll_info = ev.get("scroll", (0, 0))
                    step = f"scroll({ev['position'][0]:.1f}, {ev['position'][1]:.1f}, dx={scroll_info[0]:.2f}, dy={scroll_info[1]:.2f})"
                else:
                    step = f"{ev['type']}({ev['position'][0]:.1f}, {ev['position'][1]:.1f})"

                bef_path, _ = await self._save_frame(
                    ev["before"], ev["position"][0], ev["position"][1], f"{step}_before"
                )
                aft_path, _ = await self._save_frame(
                    aft, ev["position"][0], ev["position"][1], f"{step}_after"
                )
                await self._process_and_emit(bef_path, aft_path, ev["type"], ev)

                log.info(f"{ev['type']} captured on monitor {ev['mon']}")
                print(
                    # f"[FLUSH] [{ev['eid']}] completed event: {ev['type']} at {ev['position']} on monitor {ev['mon']}"
                )
                self._pending_event = None

            def debounce_flush():
                # callback from loop.call_later → must create task
                asyncio.create_task(flush())

            # ---- keyboard event reception ----
            async def key_event(key, typ: str):
                # Get current mouse position to determine active monitor
                x, y = mouse.Controller().position
                idx = self._mon_for(x, y, mons)
                if idx is None:
                    return

                mon = mons[idx - self._MON_START]
                x = x - mon["left"]
                y = y - mon["top"]
                log.info(f"Key {typ}: {str(key)} on monitor {idx}")

                step = f"key_{typ}({str(key)})"
                await self.update_queue.put(
                    Update(content=step, content_type="input_text")
                )

                async with self._key_activity_lock:
                    current_time = time.time()

                    # Check if this is the start of a new keyboard session
                    if (
                        self._key_activity_start is None
                        or current_time - self._key_activity_start
                        > self._key_activity_timeout
                    ):
                        # Start new session - save first screenshot
                        self._key_activity_start = current_time
                        self._key_screenshots = []
                        screenshot_path, _ = await self._save_frame(
                            self._frames[idx], x, y, f"{step}_first"
                        )
                        self._key_screenshots.append(screenshot_path)
                        log.info(
                            f"Started new keyboard session, saved first screenshot: {screenshot_path}"
                        )
                    else:
                        # Continue existing session - save intermediate screenshot
                        screenshot_path, _ = await self._save_frame(
                            self._frames[idx], x, y, f"{step}_intermediate"
                        )
                        self._key_screenshots.append(screenshot_path)
                        log.info(
                            f"Continued keyboard session, saved intermediate screenshot: {screenshot_path}"
                        )

                    # Schedule cleanup of previous intermediate screenshots
                    if len(self._key_screenshots) > 2:
                        asyncio.create_task(self._cleanup_key_screenshots())

            # ---- scroll event reception ----
            async def scroll_event(x: float, y: float, dx: float, dy: float):
                # Apply scroll filtering
                async with self._scroll_lock:
                    if not self._should_log_scroll(x, y, dx, dy):
                        if self.debug:
                            log.info(f"Scroll filtered out: dx={dx:.2f}, dy={dy:.2f}")
                        return

                idx = self._mon_for(x, y, mons)
                if idx is None:
                    return

                mon = mons[idx - self._MON_START]
                x = x - mon["left"]
                y = y - mon["top"]
                eid = time.time_ns()
                self._last_active_click_time = time.time()
                self._last_active_click_monitor_idx = idx
                self._idle_triggered = False

                # Only log significant scroll movements
                scroll_magnitude = (dx**2 + dy**2) ** 0.5
                if scroll_magnitude < 1.0:  # Very small scrolls
                    if self.debug:
                        log.info(f"Scroll too small: magnitude={scroll_magnitude:.2f}")
                    return

                log.info(
                    f"Scroll @({x:7.1f},{y:7.1f}) dx={dx:.2f} dy={dy:.2f} → mon={idx}"
                )

                if self._skip():
                    return

                async with self._frame_lock:
                    bf = self._frames[idx]
                    if bf is None:
                        return
                    self._pending_event = {
                        "type": "scroll",
                        "position": (x, y),
                        "mon": idx,
                        "before": bf,
                        "scroll": (dx, dy),
                        "eid": eid,
                    }

                # Process event immediately
                await flush()

            # ---- mouse event reception ----
            async def mouse_event(x: float, y: float, typ: str):
                idx = self._mon_for(x, y, mons)
                mon = mons[idx - self._MON_START]
                x = x - mon["left"]
                y = y - mon["top"]
                # if self._pending_event is not None:
                #     print(
                #         f"[MOUSE EVENT] [{self._pending_event['eid']}] pending event exists on monitor {self._pending_event['mon']}"
                #     )
                # await flush()
                eid = time.time_ns()
                # print(
                #     f"[MOUSE EVENT] [{eid}] {typ} at ({x}, {y}) on monitor {idx}, mon width={mon['width']}, height={mon['height']}"
                # )
                # update last active click time
                self._last_active_click_time = time.time()
                self._last_active_click_monitor_idx = idx
                self._idle_triggered = False
                log.info(
                    f"{typ:<6} @({x:7.1f},{y:7.1f}) → mon={idx}   {'(guarded)' if self._skip() else ''}"
                )
                if self._skip() or idx is None:
                    return

                async with self._frame_lock:
                    bf = self._frames[idx]
                    if bf is None:
                        return
                    self._pending_event = {
                        "type": typ,
                        "position": (x, y),
                        "mon": idx,
                        "before": bf,
                        "eid": eid,
                    }

                # Process event immediately instead of using debounce
                # await flush()
                # debounce
                if self._debounce_handle:
                    self._debounce_handle.cancel()
                    self._debounce_handle = None

                self._debounce_handle = loop.call_later(
                    self._DEBOUNCE_SEC, debounce_flush
                )

            # ---- main capture loop ----
            log.info(f"Screen observer started — guarding {self._guard or '∅'}")
            frame_count = 0

            while self._running:  # flag from base class
                t0 = time.time()

                # refresh 'before' buffers
                for idx, m in enumerate(mons, 1):
                    old_frame = None
                    async with self._frame_lock:
                        old_frame = self._frames.get(idx)

                    # Capture new frame using custom thread pool
                    try:
                        frame = await self._run_in_thread(sct.grab, m)
                    except Exception as e:
                        if self.debug:
                            logging.getLogger("Screen").error(
                                f"Failed to capture frame: {e}"
                            )
                        continue

                    async with self._frame_lock:
                        self._frames[idx] = frame

                    # Explicitly delete old frame to free memory
                    if old_frame is not None:
                        del old_frame

                    frame_count += 1

                    # Force garbage collection every 30 frames to prevent memory buildup
                    if frame_count % self._MEMORY_CLEANUP_INTERVAL == 0:
                        await self._run_in_thread(gc.collect)

                # Check for keyboard session timeout
                current_time = time.time()
                if (
                    self._key_activity_start is not None
                    and current_time - self._key_activity_start
                    > self._key_activity_timeout
                    and len(self._key_screenshots) > 1
                ):
                    # Session ended - rename last screenshot to indicate it's the final one
                    async with self._key_activity_lock:
                        if len(self._key_screenshots) > 1:
                            last_path = self._key_screenshots[-1]
                            final_path = last_path.replace("_intermediate", "_final")
                            try:
                                await self._run_in_thread(
                                    os.rename, last_path, final_path
                                )
                                self._key_screenshots[-1] = final_path
                                log.info(
                                    f"Keyboard session ended, renamed final screenshot: {final_path}"
                                )
                            except OSError:
                                pass
                        self._key_activity_start = None
                        self._key_screenshots = []

                now = time.time()
                # Check for idle state
                if (
                    now - self._last_active_click_time > self._idle_timeout
                    and not self._idle_triggered
                ):
                    self._idle_triggered = True
                    log.info("Idle state detected.")
                    image_path, timestamp = await self._inspect()
                    if self._on_idle_callback:
                        asyncio.create_task(
                            self._on_idle_callback(
                                image_path=image_path, timestamp=timestamp
                            )
                        )

                # fps throttle
                dt = time.time() - t0
                await asyncio.sleep(max(0, (1 / CAP_FPS) - dt))

            # shutdown
            mouse_listener.stop()
            print("[SCREEN OBSERVER] stopping mouse listener")
            key_listener.stop()
            if hotkey_listener is not None:
                hotkey_listener.stop()

            # Final cleanup of any remaining keyboard session
            if self._key_activity_start is not None and len(self._key_screenshots) > 1:
                async with self._key_activity_lock:
                    last_path = self._key_screenshots[-1]
                    final_path = last_path.replace("_intermediate", "_final")
                    try:
                        await self._run_in_thread(os.rename, last_path, final_path)
                        log.info(
                            f"Final keyboard session cleanup, renamed: {final_path}"
                        )
                    except OSError:
                        pass
                    await self._cleanup_key_screenshots()

            # if self._debounce_handle:
            #     self._debounce_handle.cancel()
