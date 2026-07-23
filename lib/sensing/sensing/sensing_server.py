"""
FastAPI server for exposing Streamer data via HTTP API.

`uv run python -m lib.sensing.sensing.sensing_server --observer_model=gemini/gemini-3-flash-preview` to start the server.
"""

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime

import chz
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from py_utils.logging import init_logger
from py_utils.training_recorder import TrainingRecorder, default_records_dir
from pydantic import BaseModel
from sensing.gum import GUM
from sensing.progress_detector import ProgressDetector, ProgressDetectorConfig
from sensing.screen import Screen
from sensing.segment_processor import (
    AiTutoringProcessor,
    HotKeyBuffer,
    WorkflowInductionProcessor,
)
from sensing.streamer import Streamer

logger = init_logger(__name__)


def _notify_hotkey_captured(index: int) -> None:
    """Fire a native notification after a hot-key capture.

    Uses platform-specific mechanisms:
    - macOS: osascript
    - Windows: PowerShell toast notification
    Runs in a detached subprocess — failures are logged but never raise.
    """
    import sys as _sys

    try:
        if _sys.platform == "darwin":
            script = (
                f'display notification "Screenshot #{index} saved" '
                f'with title "Coco Hot Key" '
                f'subtitle "Cmd+Shift+Space captured"'
            )
            subprocess.Popen(
                ["osascript", "-e", script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif _sys.platform == "win32":
            ps_script = (
                f"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; "
                f"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); "
                f"$text = $xml.GetElementsByTagName('text'); "
                f"$text.Item(0).AppendChild($xml.CreateTextNode('Coco Hot Key: Screenshot #{index} saved')) > $null; "
                f"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml); "
                f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Coco').Show($toast)"
            )
            subprocess.Popen(
                ["powershell", "-NoProfile", "-Command", ps_script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
    except Exception as exc:
        logger.warning(f"Could not send notification: {exc}")


class TimeRangeRequest(BaseModel):
    """Request model for querying actions by time range."""

    start_time: datetime
    end_time: datetime


class ActionsResponse(BaseModel):
    """Response model containing actions, states, and time information."""

    actions: list[str]
    states: list[dict]
    time_list: list[dict]
    count: int


class StatusResponse(BaseModel):
    """Response model for server status."""

    status: str
    total_actions: int


class ObserveUserPromptRequest(BaseModel):
    """Request model for generating an observation on a user prompt."""

    text: str
    hotkey_index: int | None = (
        None  # explicit pinned hot-key capture index (None = no capture)
    )


class ObserveUserPromptResponse(BaseModel):
    """Response model returning the generated observation string."""

    observation: str
    llm_metrics: dict | None = None
    hotkey_image_path: str | None = (
        None  # absolute path of the pinned hot-key capture, if any
    )


class HotKeyCaptureResponse(BaseModel):
    """Response model for a single hot-key capture."""

    index: int
    image_path: str
    timestamp: str
    # base64 data URL of the captured image, so callers (e.g. the Electron
    # renderer) can preview it directly without a follow-up file read.
    image_data_url: str | None = None


class HotKeyBufferResponse(BaseModel):
    """Response model listing all hot-key captures for the current session."""

    captures: list[HotKeyCaptureResponse]
    count: int


class ObserverModelRequest(BaseModel):
    """Request model for switching the observer (multimodal) model at runtime."""

    model: str


class SessionConfigRequest(BaseModel):
    """Request model for configuring the streamer with a tutor session.

    ``node_uuid`` is retained for log correlation with the cloud
    ``TutorAgentNode``, but pause / struggle events are now broadcast to local
    SSE subscribers (the tutor-worker) rather than published to Redis, so no
    Redis URL is needed here.
    """

    node_uuid: str
    struggle_detection_seconds: float = 120.0
    # Scenario: "everyday_support" (default) or "student_learning".
    # Controls which prompt directory is used by the observer and judge.
    scenario: str = "everyday_support"
    # Optional user-customized OBSERVER prompt (the "Custom" onboarding mode).
    # When set, it overrides the scenario observer prompt (written to a new file
    # in the user-data dir). The judge/tutor still use the base `scenario`.
    custom_observer_prompt: str | None = None
    # Progress / struggle-detection config (MVP).
    # These are optional overrides — if not provided, the ProgressDetectorConfig
    # defaults are used instead of hard-coded values here. This lets you tune
    # behavior in one place (progress_detector.py) without every caller having to
    # know the numbers.
    progress_detection_enabled: bool = True
    progress_check_interval_seconds: float | None = None
    progress_k_threshold: int | None = None
    progress_post_fire_cooldown_seconds: float | None = None
    progress_session_start_grace_seconds: float | None = None


# FastAPI app and global streamer / screen handles
app = FastAPI(title="Sensing Server API")
streamer: Streamer | None = None
screen: Screen | None = None
progress_detector: ProgressDetector | None = None
hotkey_buffer: HotKeyBuffer | None = None
_progress_log_path: str = "logs/progress_judgments.jsonl"
# When False (default) the product runs observer-only: ambient observation
# bubbles are shown directly from the observer's status, and the judge
# (ProgressDetector) never runs. Set --enable_judge=True to turn the judge on
# as an opt-in baseline for comparison.
_judge_enabled: bool = False
# Always-on, time-driven observation tick (decoupled from action accumulation).
observer_ticker_task: asyncio.Task | None = None


@app.get("/health", response_model=StatusResponse)
async def health_check():
    """Check server health and get status."""
    if streamer is None:
        raise HTTPException(status_code=503, detail="Streamer not initialized")
    total = await streamer.get_total_stored_actions()
    return StatusResponse(status="healthy", total_actions=total)


@app.post("/guidance_delivered", response_model=StatusResponse)
async def guidance_delivered():
    """Called by TutorAgentNode after guidance is sent to the user.

    Resets both the screen idle timer (pause detection) and the progress
    detector cooldown so neither fires a redundant intervention while
    the student absorbs the hint.
    """
    if screen is not None:
        screen.reset_idle_timer()
        logger.info("Screen idle timer reset (guidance delivered)")
    if progress_detector is not None:
        progress_detector.reset_cooldown()
    total = await streamer.get_total_stored_actions() if streamer else 0
    return StatusResponse(status="ok", total_actions=total)


@app.post("/config/observer_model", response_model=StatusResponse)
async def set_observer_model(req: ObserverModelRequest):
    """Switch the observer (multimodal) model live — no restart needed.

    The processor reads ``_observer_model`` on every observation, so mutating it
    takes effect on the next tick. Mirrors the tutor server's ``/config/model``.
    """
    ai_proc = _get_ai_processor()
    if ai_proc is None:
        raise HTTPException(status_code=503, detail="AI tutoring processor not running")
    ai_proc._observer_model = req.model
    logger.info(f"Observer model updated: {req.model}")
    total = await streamer.get_total_stored_actions() if streamer else 0
    return StatusResponse(status="ok", total_actions=total)


@app.post("/actions/query", response_model=ActionsResponse)
async def query_actions(request: TimeRangeRequest):
    """Query actions within a time range."""
    if streamer is None:
        raise HTTPException(status_code=503, detail="Streamer not initialized")

    try:
        start_timestamp = request.start_time.timestamp()
        end_timestamp = request.end_time.timestamp()

        actions, states, time_list = await streamer.get_actions_by_timerange(
            start_timestamp, end_timestamp
        )

        return ActionsResponse(
            actions=actions,
            states=states,
            time_list=time_list,
            count=len(actions),
        )
    except Exception as e:
        logger.error(f"Error querying actions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/observe/user_prompt", response_model=ObserveUserPromptResponse)
async def observe_user_prompt(request: ObserveUserPromptRequest):
    """Capture current screenshot and generate an observation for a user prompt.

    Called synchronously by TutorAgentNode when it receives a user_prompt event.
    Returns the observation string so TutorAgentNode can forward it to tutor_server.

    If the session's HotKeyBuffer contains captures, the most recent one is
    included alongside the current screenshot so the observer (and ultimately
    the tutor) can reason about the specific UI state the user flagged.
    """
    if screen is None or streamer is None:
        raise HTTPException(
            status_code=503, detail="Screen or streamer not initialized"
        )
    if progress_detector is not None:
        progress_detector.reset_timing()
    try:
        image_path, timestamp = await screen._inspect()

        # Include the explicitly pinned hot-key capture (if the user attached one)
        # so the observer LLM sees both the current screen state and the reference image.
        hk_paths: list[str] | None = None
        if hotkey_buffer is not None and request.hotkey_index is not None:
            capture = hotkey_buffer.get(request.hotkey_index)
            if capture and os.path.exists(capture.image_path):
                hk_paths = [capture.image_path]
                logger.info(
                    f"Including pinned hot-key capture #{capture.index} in observation: "
                    f"{capture.image_path}"
                )
            else:
                logger.warning(
                    f"Pinned hot-key capture #{request.hotkey_index} not found or file missing"
                )

        observation, llm_metrics = await streamer.generate_observation(
            type="user_prompt",
            user_text=request.text,
            image_path=image_path or None,
            timestamp=timestamp or None,
            hotkey_image_paths=hk_paths,
        )
        # Return the hotkey image path so TutorAgentNode can forward it
        # directly to tutor_server for vision-based annotation.
        return ObserveUserPromptResponse(
            observation=observation,
            llm_metrics=llm_metrics,
            hotkey_image_path=hk_paths[0] if hk_paths else None,
        )
    except Exception as e:
        logger.error(f"Error generating user_prompt observation: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


def _encode_image_data_url(image_path: str) -> str | None:
    """Read an image file and return a base64 data URL, or None on failure."""
    try:
        if not image_path or not os.path.exists(image_path):
            return None
        suffix = os.path.splitext(image_path)[1].lower()
        media_type = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return f"data:{media_type};base64,{b64}"
    except Exception as e:  # noqa: BLE001 — preview is best-effort
        logger.warning(f"Failed to encode hot-key image {image_path}: {e}")
        return None


@app.post("/hotkey/capture", response_model=HotKeyCaptureResponse)
async def trigger_hotkey_capture():
    """Manually trigger a hot-key capture (frontend fallback).

    Normally the Cmd+Shift+H global listener fires this automatically.
    This endpoint lets the UI trigger a capture when the browser window
    is in focus and the OS-level shortcut is unavailable.
    """
    if screen is None or hotkey_buffer is None:
        raise HTTPException(
            status_code=503, detail="Screen or hotkey buffer not initialized"
        )
    try:
        image_path, _ = await screen.capture_for_hotkey()
        if not image_path:
            raise HTTPException(
                status_code=500, detail="Capture failed — no frame available"
            )
        # capture_for_hotkey() already schedules _on_hotkey_callback via
        # asyncio.create_task, which adds the capture to hotkey_buffer.
        # Yield control so that task runs before we read the buffer.
        await asyncio.sleep(0)
        capture = hotkey_buffer.latest()
        if capture is None:
            raise HTTPException(status_code=500, detail="Capture not found in buffer")
        logger.info(f"Hot-key capture #{capture.index} saved: {image_path}")
        return HotKeyCaptureResponse(
            index=capture.index,
            image_path=capture.image_path,
            timestamp=capture.timestamp,
            image_data_url=_encode_image_data_url(capture.image_path),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error during hot-key capture: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/hotkey/buffer", response_model=HotKeyBufferResponse)
async def get_hotkey_buffer():
    """Return all hot-key captures for the current session."""
    if hotkey_buffer is None:
        raise HTTPException(status_code=503, detail="Hotkey buffer not initialized")
    captures = [
        HotKeyCaptureResponse(
            index=c.index, image_path=c.image_path, timestamp=c.timestamp
        )
        for c in hotkey_buffer.all()
    ]
    return HotKeyBufferResponse(captures=captures, count=len(captures))


@app.get("/hotkey/{index}/image")
async def get_hotkey_image(index: int):
    """Serve the raw image file for a hot-key capture by its 1-based index.

    Used by the frontend preview strip to display thumbnails.
    """
    from fastapi.responses import FileResponse

    if hotkey_buffer is None:
        raise HTTPException(status_code=503, detail="Hotkey buffer not initialized")
    capture = hotkey_buffer.get(index)
    if capture is None:
        raise HTTPException(status_code=404, detail=f"No capture with index {index}")
    if not os.path.exists(capture.image_path):
        raise HTTPException(status_code=404, detail="Image file not found on disk")
    suffix = os.path.splitext(capture.image_path)[1].lower()
    media_type = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
    return FileResponse(capture.image_path, media_type=media_type)


@app.delete("/hotkey/{index}")
async def delete_hotkey_capture(index: int):
    """Remove a hot-key capture from the buffer and delete its image file.

    Called by the frontend when the user clicks the delete button on a thumbnail.
    """
    if hotkey_buffer is None:
        raise HTTPException(status_code=503, detail="Hotkey buffer not initialized")
    capture = hotkey_buffer.remove(index)
    if capture is None:
        raise HTTPException(status_code=404, detail=f"No capture with index {index}")
    try:
        if os.path.exists(capture.image_path):
            os.remove(capture.image_path)
            logger.info(f"Deleted hot-key capture #{index}: {capture.image_path}")
    except Exception as e:
        logger.warning(f"Could not delete image file for capture #{index}: {e}")
    return {"status": "deleted", "index": index}


@app.post("/session", response_model=StatusResponse)
async def configure_session(request: SessionConfigRequest):
    """Configure the streamer for a new tutor session.

    Called by the local tutor-worker when the cloud ``TutorAgentNode`` issues a
    ``sensing.session`` notify. Pause / struggle events flow out of sensing via
    the ``/events/pause/stream`` SSE endpoint that the worker subscribes to.
    """
    if streamer is None:
        raise HTTPException(status_code=503, detail="Streamer not initialized")
    try:
        await streamer.configure_session()
        # Apply the user-chosen idle timeout to the screen instance
        if screen is not None:
            screen.set_idle_timeout(request.struggle_detection_seconds)
            logger.info(
                f"Screen idle timeout set to {request.struggle_detection_seconds}s"
            )
        logger.info(
            f"Streamer configured for node_uuid={request.node_uuid}, "
            f"scenario={request.scenario}"
        )

        # Apply scenario to the AiTutoringProcessor (updates observer prompt)
        # and forward it to the tutor server (updates diagnostic/tutor prompts).
        for proc in streamer._segment_processors:
            if isinstance(proc, AiTutoringProcessor):
                await proc.set_scenario(
                    request.scenario, request.custom_observer_prompt
                )
                proc.set_session_active(True)
                logger.info(f"AiTutoringProcessor scenario set to {request.scenario!r}")
                # Key training rows on this session and stamp the manifest.
                if proc._recorder is not None:
                    proc._recorder.set_session(
                        request.node_uuid,
                        scenario=request.scenario,
                        struggle_detection_seconds=request.struggle_detection_seconds,
                        started_at=time.time(),
                    )
                break

        # Start / restart the progress (struggle) detector for this session
        await _start_progress_detector(request)

        return StatusResponse(
            status="ok", total_actions=await streamer.get_total_stored_actions()
        )
    except Exception as e:
        logger.error(f"Error configuring session: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/session/end", response_model=StatusResponse)
async def end_session():
    """Signal that the current tutor session has ended.

    Marks the AiTutoringProcessor as idle so the proactive judge reverts to
    invite mode (offering to start a new session) instead of in-chat nudges.
    The detector keeps running — it is now continuous, not session-scoped.
    """
    ai_proc = _get_ai_processor()
    if ai_proc is not None:
        ai_proc.set_session_active(False)
        logger.info("AiTutoringProcessor: session ended, reverted to pre-session mode")

    # Revert the still-running detector to pre-session (invite) mode.
    await _start_progress_detector(None)

    total = await streamer.get_total_stored_actions() if streamer else 0
    return StatusResponse(status="ok", total_actions=total)


async def _start_progress_detector(request: SessionConfigRequest | None = None) -> None:
    """Ensure the proactive judge (ProgressDetector) is running and configured.

    The detector runs **continuously** and owns every proactive fire:
    - ``request is None`` (pre-session): it evaluates whether to INVITE the user
      to start a session.
    - ``request`` provided (a session is starting): it switches to in-chat nudges
      and is reconfigured in place (interval/scenario) and its timing reset.

    A session that explicitly disables progress detection stops it.
    """
    global progress_detector
    if streamer is None or screen is None:
        return

    # Observer-only mode (default): the judge never runs. Make sure any
    # previously-started detector is stopped, then bail.
    if not _judge_enabled:
        if progress_detector is not None:
            try:
                await progress_detector.stop()
            except Exception:
                pass
            progress_detector = None
        logger.info(
            "ProgressDetector disabled (observer-only mode; --enable_judge=False)"
        )
        return

    # A session can explicitly disable proactive detection entirely.
    if request is not None and not request.progress_detection_enabled:
        if progress_detector is not None:
            try:
                await progress_detector.stop()
            except Exception:
                pass
            progress_detector = None
        logger.info("ProgressDetector disabled for this session")
        return

    ai_proc = _get_ai_processor()
    if ai_proc is None:
        logger.warning("No AiTutoringProcessor — progress detector cannot start")
        return

    scenario = request.scenario if request is not None else "everyday_support"
    mode = "session" if request is not None else "pre-session"

    if progress_detector is None:
        # First start (typically pre-session, at server startup).
        cfg = ProgressDetectorConfig(enabled=True)
        if request is not None:
            cfg.check_interval_seconds = (
                request.progress_check_interval_seconds
                or request.struggle_detection_seconds
            )
            if request.progress_k_threshold is not None:
                cfg.k_threshold = request.progress_k_threshold
            if request.progress_post_fire_cooldown_seconds is not None:
                cfg.post_fire_cooldown_seconds = (
                    request.progress_post_fire_cooldown_seconds
                )
            if request.progress_session_start_grace_seconds is not None:
                cfg.session_start_grace_seconds = (
                    request.progress_session_start_grace_seconds
                )
        progress_detector = ProgressDetector(
            ai_processor=ai_proc,
            screen=screen,
            streamer=streamer,
            log_path=_progress_log_path,
            config=cfg,
            scenario=scenario,
        )
        await progress_detector.start()
        logger.info(f"ProgressDetector started ({mode} mode)")
        return

    # Already running — reconfigure in place for the new phase.
    if request is not None:
        progress_detector.update_config(
            check_interval_seconds=(
                request.progress_check_interval_seconds
                or request.struggle_detection_seconds
            ),
            k_threshold=request.progress_k_threshold,
            post_fire_cooldown_seconds=request.progress_post_fire_cooldown_seconds,
            session_start_grace_seconds=request.progress_session_start_grace_seconds,
        )
    progress_detector.set_scenario(scenario)
    progress_detector.reset_cooldown()
    progress_detector.reset_timing()
    logger.info(f"ProgressDetector reconfigured ({mode} mode)")


def _get_ai_processor() -> AiTutoringProcessor | None:
    """Return the running AiTutoringProcessor, or None if it isn't enabled."""
    if streamer is None:
        return None
    for proc in streamer._segment_processors:
        if isinstance(proc, AiTutoringProcessor):
            return proc
    return None


async def _observer_ticker(interval_seconds: float) -> None:
    """Always-on, time-driven observation tick.

    Every ``interval_seconds`` we capture a fresh screenshot and produce an
    observation — but only if the user has been active within the last
    ~2 intervals. This decouples observation cadence from action accumulation
    (the snapshot buffer), so low-distinct-action activity like scrolling and
    short tasks get timely observations. A static/idle screen is skipped to
    avoid burning VLM calls — true idle is covered by the screen ``pause`` path.

    Scrolling counts as activity (it refreshes the screen's last-active
    timestamp) even though it logs almost no action segments, which is exactly
    why a time-driven tick catches it where the action path does not.
    """
    activity_window = max(interval_seconds * 2, interval_seconds + 5.0)
    logger.info(
        f"Observer ticker started (interval={interval_seconds}s, "
        f"activity_window={activity_window}s)"
    )
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            if screen is None:
                continue
            ai_proc = _get_ai_processor()
            if ai_proc is None:
                continue
            # Skip when the user has been idle — the pause path handles that.
            if time.time() - screen.get_last_active_click_time() > activity_window:
                continue
            image_path, timestamp = await screen._inspect()
            if not image_path:
                continue
            ai_proc._add_snapshot(image_path, timestamp)
            await ai_proc._handle_observation(type="snapshot")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug(f"Observer ticker tick failed: {e}")


class FeedbackRequest(BaseModel):
    """A user's explicit reaction to a proactive suggestion.

    ``kind``: ``engage`` | ``dismiss`` | ``thumbs_up`` | ``thumbs_down``.
    ``surface``: ``bubble`` (avatar observation bubble) | ``chat`` (tutor message).
    """

    kind: str
    surface: str = "bubble"
    observation_id: str | None = None
    message_id: str | None = None
    status: str | None = None
    latency_s: float | None = None
    text: str | None = None
    session_id: str | None = None


@app.post("/feedback", response_model=StatusResponse)
async def record_feedback(req: FeedbackRequest):
    """Log an explicit user reaction into the shared training-data recorder.

    Routed here from the UI (bubble engage/dismiss, chat thumbs up/down) so all
    feedback lands in one ``feedback.jsonl`` alongside the observations/decisions.
    """
    ai_proc = _get_ai_processor()
    # Keep an in-memory reaction for this observation so the observer can avoid
    # re-raising a just-dismissed suggestion (injected into its next prompt).
    if ai_proc is not None and req.observation_id:
        ai_proc.record_reaction(req.observation_id, req.kind)
    rec = getattr(ai_proc, "_recorder", None) if ai_proc is not None else None
    if rec is None:
        # No recorder (e.g. ai_tutoring disabled) — accept but no-op.
        return StatusResponse(status="ok", total_actions=0)
    rec.log_feedback(
        ts=time.time(),
        session_id=req.session_id or getattr(rec, "_session_id", None),
        kind=req.kind,
        surface=req.surface,
        observation_id=req.observation_id,
        message_id=req.message_id,
        status=req.status,
        latency_s=req.latency_s,
        text=req.text,
    )
    logger.info(
        f"Feedback logged: kind={req.kind} surface={req.surface} "
        f"obs={req.observation_id} msg={req.message_id}"
    )
    return StatusResponse(status="ok", total_actions=0)


@app.get("/events/pause/stream")
async def pause_event_stream():
    """SSE stream of pause / struggle events.

    Replaces the prior Redis pubsub channel ``sensing/{node_uuid}/pause_detected``.
    Each event payload is the same JSON envelope used before — typically:
    ``{"data": {"data_type": "pause_detected", "observation": ..., "text": ...,
    "trigger_reason": ..., "evidence": ...}}``. The local tutor-worker
    subscribes to this stream and forwards events to the cloud TutorAgentNode
    over the WebSocket.

    Subscribers are unregistered automatically when the stream is closed.
    """
    ai_proc = _get_ai_processor()
    if ai_proc is None:
        raise HTTPException(
            status_code=503,
            detail="AiTutoringProcessor not active — pause stream unavailable",
        )

    queue = ai_proc.subscribe_pause()

    async def event_gen():
        try:
            yield 'data: {"type": "ready"}\n\n'
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            ai_proc.unsubscribe_pause(queue)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.get("/observations/stream")
async def observations_stream():
    """Server-Sent Events stream of every observation as it's produced.

    Consumers (e.g. the Electron avatar UI) get one event per observation:
    ``{"type": "snapshot|pause|user_prompt", "observation": str, "ts": float,
    "scenario": str}``. A 15-second SSE comment keepalive is sent so idle
    proxies don't tear the connection down. The subscriber queue is unregistered
    on disconnect.
    """
    ai_proc = _get_ai_processor()
    if ai_proc is None:
        raise HTTPException(
            status_code=503,
            detail="AiTutoringProcessor not active — observation stream unavailable",
        )

    queue = ai_proc.subscribe_observations()

    async def event_gen():
        try:
            # Hello event so consumers know the stream is live before any
            # real observation arrives (cycles can be 20s+ apart).
            yield 'data: {"type": "ready"}\n\n'
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # SSE comment keepalive — ignored by parsers, keeps the
                    # connection warm through proxies.
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            ai_proc.unsubscribe_observations(queue)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


async def start_fastapi_server(host: str = "127.0.0.1", port: int = 8080):
    """Run FastAPI with uvicorn inside asyncio loop."""
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


async def main_async(
    port: int,
    check_interval: float,
    min_actions_threshold: int,
    workflow_induction: bool,
    ai_tutoring: bool,
    tutor_url: str,
    observer_model: str,
    enable_judge: bool = False,
    observer_interval_seconds: float = 15.0,
):
    """Start GUM, Streamer, and FastAPI server concurrently."""
    global streamer
    global screen
    global hotkey_buffer
    global _progress_log_path
    global _judge_enabled
    global observer_ticker_task
    _judge_enabled = enable_judge
    logger.info(
        f"Proactive mode: {'observer + judge' if enable_judge else 'observer-only'} "
        f"(enable_judge={enable_judge})"
    )
    timestamp = int(time.time())
    # Prefer the shared records dir ($COCO_RECORDS_DIR, set by the launcher so the
    # sensing and tutor processes write to one joinable dir); else per-run default.
    session_dir = default_records_dir(
        fallback=f"~/Downloads/coco-records/session_{timestamp}"
    )
    db_path = f"{session_dir}/actions.db"
    screenshot_dir = f"{session_dir}/screenshots"
    import os as _os

    _progress_log_path = _os.path.expanduser(f"{session_dir}/progress_judgments.jsonl")

    # Initialize screen observer
    screen = Screen(
        screenshots_dir=screenshot_dir,
        debug=False,
        enable_global_hotkey=False,
    )

    # Initialize hot-key buffer and register the capture callback on the screen.
    hotkey_buffer = HotKeyBuffer(max_size=10)

    async def _on_hotkey(image_path: str, timestamp: str) -> None:
        """Callback invoked by Screen after each Cmd+Shift+Space capture."""
        if hotkey_buffer is not None:
            capture = hotkey_buffer.add(image_path=image_path, timestamp=timestamp)
        logger.info(
            f"Hot-key capture #{capture.index} stored: {image_path} @ {timestamp}"
        )
        # Fire a macOS system notification so the user gets immediate feedback.
        _notify_hotkey_captured(capture.index)

    screen.register_on_hotkey(_on_hotkey)

    # Build segment processors based on enabled features
    sensing_log_dir = os.path.join(tempfile.gettempdir(), "sensing_logs")
    os.makedirs(sensing_log_dir, exist_ok=True)
    ai_tutor_output_log = os.path.join(
        sensing_log_dir, "ai_tutor_streamer" + time.strftime("_%Y%m%d_%H%M%S.log")
    )
    processors = []
    if workflow_induction:
        processors.append(WorkflowInductionProcessor())
    if ai_tutoring:
        ai_processor = AiTutoringProcessor.from_config(
            tutor_url=tutor_url,
            ai_tutor_output_log=ai_tutor_output_log,
            observer_model=observer_model,
            # node_uuid and redis_url are configured later via POST /session
        )
        processors.append(ai_processor)
        # Attach the training-data recorder so every observer call and judge
        # decision is logged (observations.jsonl / decisions.jsonl / episodes.jsonl)
        # into the same per-run directory as progress_judgments.jsonl.
        ai_processor._recorder = TrainingRecorder(
            out_dir=_os.path.dirname(_progress_log_path)
        )
        # Reset the tutor server's per-session state at startup so any conversation
        # history or curriculum state left over from a previous run doesn't bleed
        # into pre-session observations (task-suggestion notifications etc.).
        # Retry with backoff so a slow tutor-server startup doesn't leave stale
        # state silently in place.
        _reset_delays = [0.5, 1.0, 2.0, 4.0]
        for _attempt, _delay in enumerate(_reset_delays, start=1):
            try:
                async with __import__("httpx").AsyncClient(timeout=10.0) as _client:
                    _resp = await _client.post(f"{tutor_url.rstrip('/')}/context/reset")
                    _resp.raise_for_status()
                logger.info(
                    "Tutor server session state reset at sensing server startup"
                )
                break
            except Exception as _e:
                if _attempt < len(_reset_delays):
                    logger.warning(
                        f"Could not reset tutor server at startup (attempt {_attempt}): {_e}. "
                        f"Retrying in {_delay}s..."
                    )
                    await __import__("asyncio").sleep(_delay)
                else:
                    logger.error(
                        f"Could not reset tutor server after {len(_reset_delays)} attempts: {_e}. "
                        "Stale session state (curriculum_state, conversation_history) may persist "
                        "until the first session is registered via POST /session."
                    )

    # Initialize streamer — processing concerns live entirely in the processors
    streamer = Streamer(
        db_path=db_path,
        screenshot_dir=screenshot_dir,
        check_interval=check_interval,
        min_actions_threshold=min_actions_threshold,
        enable_hotkey=False,
        segment_processors=processors,
    )

    try:
        logger.info("Starting GUM context, streamer, and FastAPI server...")
        # Pause detection: screen idle → streamer generates observation → publishes to Redis
        screen.register_on_idle(streamer._process_actions_pause)
        # Note: user_prompt is now driven by TutorAgentNode via POST /observe/user_prompt
        # so we do NOT register screen.register_on_user_prompt here
        print("before GUM")
        async with GUM("test", screen, data_directory=session_dir):
            # Run streamer and FastAPI server concurrently
            print("inside GUM")
            # Start the proactive judge in pre-session (invite) mode. It runs
            # continuously; POST /session reconfigures it for in-chat nudges.
            await _start_progress_detector(None)
            # Always-on, time-driven observation tick (covers scrolling / short
            # tasks that the action-accumulation path misses).
            if ai_tutoring and observer_interval_seconds > 0:
                observer_ticker_task = asyncio.create_task(
                    _observer_ticker(observer_interval_seconds)
                )
            await asyncio.gather(
                streamer.start(),
                start_fastapi_server(port=port),
            )

    except asyncio.CancelledError:
        pass
    except KeyboardInterrupt:
        logger.info("Shutting down gracefully...")
    except Exception as e:
        logger.error(f"Fatal error during startup: {e}", exc_info=True)
    finally:
        logger.info(
            "Stopping streamer, screen, observer ticker, and progress detector..."
        )
        if observer_ticker_task is not None:
            observer_ticker_task.cancel()
            try:
                await observer_ticker_task
            except (asyncio.CancelledError, Exception):
                pass
        if progress_detector is not None:
            try:
                await progress_detector.stop()
            except Exception as e:
                logger.warning(f"ProgressDetector stop failed: {e}")
        await streamer.stop()
        await screen.stop()
        logger.info("Stopped cleanly.")


def main(
    port: int = 8080,
    check_interval: float = 20.0,
    min_actions_threshold: int = 2,
    workflow_induction: bool = False,
    ai_tutoring: bool = True,
    tutor_url: str = "http://localhost:8081",
    observer_model: str = "",
    enable_judge: bool = False,
    observer_interval_seconds: float = 15.0,
):
    # The observer model must be supplied explicitly; there is no built-in
    # default so the caller (CLI or desktop app) always chooses it consciously.
    if not (observer_model or "").strip():
        raise ValueError("--observer_model is required")
    asyncio.run(
        main_async(
            port=port,
            check_interval=check_interval,
            min_actions_threshold=min_actions_threshold,
            workflow_induction=workflow_induction,
            ai_tutoring=ai_tutoring,
            tutor_url=tutor_url,
            observer_model=observer_model,
            enable_judge=enable_judge,
            observer_interval_seconds=observer_interval_seconds,
        )
    )


if __name__ == "__main__":
    chz.entrypoint(main, allow_hyphens=True)
