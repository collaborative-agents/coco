"""Segment processors for the Streamer pipeline.

Each processor implements ``SegmentProcessor.process()`` and is registered with
``Streamer`` at construction time.  After every segmentation cycle,
``Streamer._process_actions`` calls every registered processor with a *uniform*
argument set — processors simply ignore the arguments they do not care about.

Bundled processors
------------------
WorkflowInductionProcessor
    Derives step-by-step goals from raw action segments.

AiTutoringProcessor
    Generates observations via ObserverAgent and forwards them to the AI tutor
    system (HTTP for user-prompt observations, Redis for pause events).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import uuid
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import httpx
from external_api.llm import chat_completion
from external_api.types import LLMCallMetrics
from memory import MemoryEngine, ObservationInput
from py_utils.logging import init_logger
from py_utils.training_recorder import TrainingRecorder
from sensing.language import ActionNode, SequenceNode, annotate_high_level_nodes

logger = init_logger(__name__)

# ---------------------------------------------------------------------------
# Local Snapshot type (was imported from proactive_tutor.tutor_types)
# ---------------------------------------------------------------------------


@dataclass
class Snapshot:
    """A screenshot captured at a specific point in time."""

    image_path: str
    timestamp: str


@dataclass
class HotKeyCapture:
    """A screenshot deliberately captured by the user via the hot-key shortcut."""

    index: int  # 1-based label shown to the user as hk1, hk2, …
    image_path: str
    timestamp: str


# ---------------------------------------------------------------------------
# Observer helper (replaces ObserverAgent + GeminiClient)
# ---------------------------------------------------------------------------


def _load_observer_prompt(scenario: str = "everyday_support") -> str:
    """Load the observer prompt for the given scenario.

    ``"student_learning"`` → prompts_problem_solving/observer.txt
    Any other value (including ``"everyday_support"``) → prompts_everyday/observer.txt
    """
    prompt_dir = {
        "student_learning": "prompts_problem_solving",
    }.get(scenario, "prompts_everyday")
    return (Path(__file__).parent / prompt_dir / "observer.txt").read_text(encoding="utf-8")


def _custom_observer_prompt_path() -> Path:
    """Path of the user's custom observer prompt in the app's user-data dir.

    Electron passes its ``app.getPath('userData')`` via ``COCO_USER_DATA_DIR``;
    we fall back to ``~/.coco`` when running the services standalone. The custom
    prompt is written to its OWN file so the bundled scenario prompts are never
    overwritten.
    """
    base = os.environ.get("COCO_USER_DATA_DIR")
    root = Path(base) if base else (Path.home() / ".coco")
    return root / "custom_prompts" / "observer.txt"


def _install_custom_observer_prompt(prompt: str) -> str:
    """Write the custom observer prompt to a new file in the user-data dir and
    return its contents. Never overwrites the packaged scenario prompts."""
    path = _custom_observer_prompt_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prompt, encoding="utf-8")
    logger.info(f"Custom observer prompt written to {path}")
    return path.read_text(encoding="utf-8")


_OBSERVER_PROMPT: str = _load_observer_prompt()


def build_multimodal_messages(
    *,
    system_prompt: str | None,
    user_prompt: str,
    image_paths: list[str] | None = None,
):
    content = []

    content.append({"type": "text", "text": user_prompt})

    for path in image_paths or []:
        if not os.path.exists(path):
            continue

        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        suffix = Path(path).suffix.lstrip(".").lower()
        mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix or 'png'}"

        content.append(
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        )

    messages = []

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    messages.append({"role": "user", "content": content})

    return messages


def _observe(
    text_prompt: str,
    image_paths: list[str] | None = None,
    *,
    model: str,
    system_prompt: str = _OBSERVER_PROMPT,
    max_tokens: int = 4096,
) -> tuple[str, LLMCallMetrics]:
    """Generate an observer response."""
    # user_content: list[TextContent | ImageURLContent] = []

    # for path in image_paths or []:
    #     if not os.path.exists(path):
    #         logger.warning(f"Observer: image not found, skipping — {path}")
    #         continue
    #     with open(path, "rb") as fh:
    #         b64 = base64.b64encode(fh.read()).decode()
    #     suffix = Path(path).suffix.lstrip(".").lower()
    #     mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix or 'png'}"
    #     user_content.append(
    #         ImageURLContent(image_url=ImageURL(url=f"data:{mime};base64,{b64}"))
    #     )

    # user_content.append(TextContent(text=text_prompt))

    # messages = [
    #     LiteLLMMessage(role="system", content=[TextContent(text=system_prompt)]),
    #     LiteLLMMessage(role="user", content=user_content),
    # ]

    # result, _ = get_litellm_completion(
    #     messages=messages, model=model, max_tokens=max_tokens
    # )

    # for block in result.content:
    #     if isinstance(block, TextContent):
    #         return block.text
    # return ""

    messages = build_multimodal_messages(
        system_prompt=system_prompt,
        user_prompt=text_prompt,
        image_paths=image_paths,
    )

    result, metrics = chat_completion(
        messages=messages,
        model=model,
        max_tokens=max_tokens,
        operation="observer",
    )

    if isinstance(result.content, str):
        return result.content, metrics

    if isinstance(result.content, list):
        for block in result.content:
            if isinstance(block, dict) and block.get("type") == "text":
                return block.get("text", ""), metrics
            if hasattr(block, "text"):
                return block.text, metrics  # type: ignore

    return "", metrics


# ---------------------------------------------------------------------------
# Observation classifier (raw observer JSON → coarse user-facing status)
# ---------------------------------------------------------------------------


def _extract_json_block(text: str) -> str | None:
    """Pull out the first JSON object from a possibly-fenced LLM response."""
    if not text:
        return None
    s = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", s, re.DOTALL)
    if fence:
        return fence.group(1)
    if s.startswith("{"):
        return s
    brace = re.search(r"\{.*\}", s, re.DOTALL)
    return brace.group(0) if brace else None


# Sentinel strings the observer prompts emit when nothing's wrong. Compared
# case-insensitively against the field value after stripping punctuation.
_STUCK_NEGATIVE = {"not stuck", ""}
_MISTAKE_NEGATIVE = {
    "no mistake so far",
    "no mistake",
    "no human mistake detected",
    "",
}
_INEFFICIENCY_NEGATIVE = {
    "no inefficiency detected",
    "no delegation opportunity",
    "",
}
_AI_NEGATIVE = {"no ai interaction problem", ""}

# How long to suppress repeated pre-session task-suggestion events (seconds).
_TASK_SUGGESTION_COOLDOWN_S: float = 5 * 60.0


def _extract_task_label(observation: str) -> str | None:
    """Pull a short task label from the observer JSON's ``user_intent`` field.

    Returns the intent string truncated to 120 characters, or ``None`` if the
    field is absent or too short to be meaningful.
    """
    raw = _extract_json_block(observation)
    if raw is None:
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    intent = str(obj.get("user_intent") or "").strip()
    if len(intent) < 5:
        return None
    return intent[:120]


_EXPLICIT_STATUS_VALUES = {
    "progress",
    "mistake",
    "inefficient",
    "ai_struggle",
    "stuck",
    "observing",
}


def _classify_observation_status(
    scenario: str, observation: str, session_active: bool = False
) -> str:
    """Map a raw observer JSON output to a coarse user-facing status string.

    Returns one of:
        "progress"       — default (no negative signals)
        "stuck"          — student-learning ``stuck`` field reported being stuck
        "mistake"        — student-learning ``mistakes`` field reported a mistake
        "inefficient"    — worker-upskilling inefficiency pattern detected
        "ai_struggle"    — legacy worker-upskilling AI-tool problem detected
        "task_complete"  — observer judged the task to be finished (session active only)
        "observing"      — couldn't parse / no scenario fields recognized

    For the worker scenario the observer now emits an explicit ``status`` field
    (one of "progress", "mistake", "inefficient", "stuck", "observing").
    We use that directly when present so we don't have to re-infer from
    ``inefficiency_patterns`` / ``mistake_made_by_human``. The inference path
    is kept as a fallback for older observer outputs without the field.

    The renderer uses this to pick a friendly phrase from a pool — the raw
    observation text is still included in the SSE event for power users.
    """
    raw = _extract_json_block(observation)
    if raw is None:
        return "observing"
    try:
        obj = json.loads(raw)
    except Exception:
        return "observing"
    if not isinstance(obj, dict):
        return "observing"

    def _norm(v: object) -> str:
        return str(v or "").strip().lower().rstrip(".")

    # task_complete is only meaningful once a session is running.
    if session_active:
        if _norm(obj.get("task_complete")) == "yes":
            return "task_complete"

    if scenario == "student_learning":
        stuck = _norm(obj.get("stuck"))
        if stuck and stuck not in _STUCK_NEGATIVE:
            return "stuck"
        mistakes = _norm(obj.get("mistakes"))
        if mistakes and mistakes not in _MISTAKE_NEGATIVE:
            return "mistake"
        # If neither field is present at all, we got JSON but not the schema
        # we recognize — treat as a neutral "observing" rather than claiming
        # progress we have no evidence for.
        if not (obj.get("stuck") or obj.get("mistakes")):
            return "observing"
        return "progress"

    # Worker / "ai_upskilling" schema.
    # 1. Prefer the explicit ``status`` field added in the updated observer prompt.
    explicit = _norm(obj.get("status"))
    if explicit in _EXPLICIT_STATUS_VALUES:
        return explicit

    # 2. Legacy inference path — kept for backward-compat with older observer outputs.
    human_mistake = _norm(obj.get("mistake_made_by_human"))
    if human_mistake and human_mistake not in _MISTAKE_NEGATIVE:
        return "mistake"
    # Compatibility with observations recorded before the field was renamed.
    ai_problems = _norm(obj.get("ai_interaction_problems"))
    if ai_problems and ai_problems not in _AI_NEGATIVE:
        return "ai_struggle"
    inefficiency = _norm(obj.get("inefficiency_patterns"))
    if inefficiency and inefficiency not in _INEFFICIENCY_NEGATIVE:
        return "inefficient"
    if not (
        obj.get("inefficiency_patterns")
        or obj.get("mistake_made_by_human")
        or obj.get("ai_interaction_problems")
    ):
        return "observing"
    return "progress"


def _extract_applying_ai_output(observation: str) -> str | None:
    """Pull the ``applying_ai_output`` field from an observer JSON string.

    Returns "yes", "no", or None if the field is absent or the text is not JSON.
    Used to surface the discernment-opportunity signal to SSE subscribers.
    """
    raw = _extract_json_block(observation)
    if raw is None:
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    val = str(obj.get("applying_ai_output", "")).strip().lower()
    return val if val in ("yes", "no") else None


# ---------------------------------------------------------------------------
# Shared data types
# ---------------------------------------------------------------------------


class SnapshotBuffer:
    """Rolling buffer of recent screenshots plus accumulated observation history."""

    def __init__(self, max_size: int = 6) -> None:
        self.buffer: list[Snapshot] = []
        self.max_size = max_size
        self.obs_history: list[str] = []

    def add_snapshot(self, image_path: str, timestamp: str) -> None:
        self.buffer.append(Snapshot(image_path, timestamp))

    def history(self, last_n: int | None = None) -> list[Snapshot]:
        return self.buffer if last_n is None else self.buffer[-last_n:]


class HotKeyBuffer:
    """Session-persistent buffer of user-flagged screenshots (Cmd+Shift+H captures).

    Unlike ``SnapshotBuffer`` (rolling, auto-managed), captures here are kept
    for the entire session and are never deleted by the sensing pipeline — they
    exist as explicit reference points chosen by the user.
    """

    def __init__(self, max_size: int = 10) -> None:
        self._captures: list[HotKeyCapture] = []
        self._max_size = max_size

    def add(self, image_path: str, timestamp: str) -> HotKeyCapture:
        """Add a new capture and return it.  Oldest entry is evicted if over capacity."""
        index = (self._captures[-1].index + 1) if self._captures else 1
        capture = HotKeyCapture(index=index, image_path=image_path, timestamp=timestamp)
        self._captures.append(capture)
        if len(self._captures) > self._max_size:
            self._captures = self._captures[-self._max_size :]
        return capture

    def latest(self) -> HotKeyCapture | None:
        """Return the most recent capture, or None if the buffer is empty."""
        return self._captures[-1] if self._captures else None

    def get(self, index: int) -> HotKeyCapture | None:
        """Return the capture with the given 1-based index, or None."""
        for c in self._captures:
            if c.index == index:
                return c
        return None

    def remove(self, index: int) -> HotKeyCapture | None:
        """Remove and return the capture with the given index, or None if not found."""
        for i, c in enumerate(self._captures):
            if c.index == index:
                return self._captures.pop(i)
        return None

    def all(self) -> list[HotKeyCapture]:
        """Return all captures, oldest first."""
        return list(self._captures)

    def clear(self) -> None:
        self._captures.clear()


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class SegmentProcessor(ABC):
    """Abstract base for all segment processors.

    ``Streamer`` calls ``process()`` after every segmentation cycle with a
    *uniform* argument set.  Subclasses decide which arguments they need.

    The ``type`` argument tells each processor which kind of event triggered
    the cycle:

    * ``"snapshot"``    — periodic background cycle; ``segments`` is populated.
    * ``"pause"``       — student idle timeout; ``image_path``/``timestamp`` set.
    * ``"user_prompt"`` — student typed a message; all three extra args set.
    """

    @abstractmethod
    async def process(
        self,
        segments: list | None = None,
        type: str | None = None,
        user_text: str | None = None,
        image_path: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        """Process a segmented batch of actions.

        Args:
            segments:  List of action-segment lists from ``trigger_segmentation()``.
                       Populated for ``type="snapshot"``; ``None`` otherwise.
            type:      Event type — ``"snapshot"``, ``"pause"``, or ``"user_prompt"``.
            user_text: Student's typed input (``user_prompt`` only).
            image_path: Path to a freshly captured screenshot (``pause`` /
                        ``user_prompt``).
            timestamp: Timestamp string for the screenshot (``pause`` /
                       ``user_prompt``).
        """

    @abstractmethod
    async def close(self) -> None:
        """Optional cleanup hook called when ``Streamer`` stops."""


# ---------------------------------------------------------------------------
# Workflow induction processor
# ---------------------------------------------------------------------------


class WorkflowInductionProcessor(SegmentProcessor):
    """Derives high-level goals from raw action segments.

    Only acts on ``type="snapshot"`` cycles where ``segments`` is populated.
    Pause and user-prompt events are silently ignored.
    """

    def __init__(self) -> None:
        self.workflow_steps: list[dict] = []

    async def process(
        self,
        segments: list | None = None,
        type: str | None = None,
        **_kwargs,
    ) -> None:
        # Workflow induction only makes sense for snapshot segments
        if type != "snapshot" or not segments:
            return

        for seg in segments:
            if len(seg) == 1:
                node = ActionNode(
                    action=seg[0]["action"],
                    state=seg[0]["state_str"],
                    time={"before": seg[0]["timestamp"], "after": seg[0]["timestamp"]},
                )
                node.get_goal()
            else:
                node = SequenceNode(
                    nodes=[
                        ActionNode(
                            action=s["action"],
                            state=s["state_str"],
                            time={"before": s["timestamp"], "after": s["timestamp"]},
                        )
                        for s in seg
                    ]
                )
                node = annotate_high_level_nodes(node)

            logger.info(f"[{node.node_type.value}] Goal: {node.goal}")
            self.workflow_steps.append({"goal": node.goal, "status": node.status})

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# AI tutoring processor
# ---------------------------------------------------------------------------


class AiTutoringProcessor(SegmentProcessor):
    """Generates observations and forwards them to the AI tutor system.

    Owns all AI-tutoring state: the snapshot buffer, observer agent, HTTP
    client, and Redis publisher.  Three event types are handled:

    * ``"snapshot"``    — adds the latest screenshot to the buffer; when the
                          buffer is full an observation is generated and stored
                          in ``obs_history`` for future context.
    * ``"pause"``       — generates an observation and publishes it to a Redis
                          channel so ``TutorAgentNode`` can act on it.
    * ``"user_prompt"`` — generates and *returns* an observation (also
                          accessible via ``generate_observation()``).
    """

    def __init__(
        self,
        http_client: httpx.AsyncClient,
        tutor_url: str,
        ai_tutor_output_log: str,
        snapshot_buffer_max_size: int = 6,
        *,
        observer_model: str,
        scenario: str = "everyday_support",
        memory_engine: MemoryEngine | None = None,
    ) -> None:
        self._http_client = http_client
        self.tutor_url = tutor_url.rstrip("/")
        self.ai_tutor_output_log = ai_tutor_output_log
        self.snapshot_buffer = SnapshotBuffer(max_size=snapshot_buffer_max_size)
        self._image_num: int = 0
        self._observer_model = observer_model
        self._scenario = scenario
        self._memory_engine = memory_engine
        self._memory_session_id: str | None = None
        # Per-session observer prompt (can be updated via set_scenario).
        self._observer_prompt: str = _load_observer_prompt(scenario)
        # Ring buffer of recent observer outputs for the text-only progress
        # judge. Each entry: {"ts": float, "type": str, "obs": str,
        # "observation_id": str}.
        self._observation_history: deque[dict] = deque(maxlen=20)
        # Optional training-data recorder (set by the server at startup). Logs
        # each observer call so decisions can be linked back to observer I/O.
        self._recorder: TrainingRecorder | None = None
        # observation_id of the most recent observer call, so the judge can
        # reference the fresh "progress_check" observation it just triggered.
        self._last_observation_id: str | None = None
        # Screenshot retained briefly for the eager instant-suggestion request.
        self._last_observation_image_paths: list[str] = []
        # observation_id -> user reaction ("shown" | "engage" | "dismiss" |
        # "thumbs_up" | "thumbs_down"), updated from POST /feedback. Injected
        # back into the observer prompt so it doesn't re-raise a suggestion the
        # user just dismissed.
        self._reactions: dict[str, str] = {}
        # Live subscribers (e.g. SSE clients on the Electron UI) that receive
        # every observation as it is produced.
        self._obs_subscribers: list[asyncio.Queue] = []
        # Subscribers for pause / struggle events specifically. The local
        # tutor-worker subscribes to forward these to the cloud TutorAgentNode
        # over its WebSocket; in dev other consumers can subscribe too.
        self._pause_subscribers: list[asyncio.Queue] = []
        # Whether a tutor session is currently active.  Controls which
        # proactive signals are emitted (task_suggested vs task_complete).
        self._session_active: bool = False
        # Timestamp of the last task_suggested event; used to rate-limit
        # pre-session prompts so the user isn't pinged every observation cycle.
        self._last_suggestion_ts: float = 0.0

    # ------------------------------------------------------------------
    # Factory helper
    # ------------------------------------------------------------------

    @classmethod
    def from_config(
        cls,
        tutor_url: str,
        ai_tutor_output_log: str,
        snapshot_buffer_max_size: int = 6,
        *,
        observer_model: str,
        scenario: str = "everyday_support",
        memory_engine: MemoryEngine | None = None,
    ) -> AiTutoringProcessor:
        """Build an ``AiTutoringProcessor`` from high-level config values.

        The observer prompt is read from the scenario-specific prompts directory
        bundled with this package (``prompts_problem_solving/observer.txt`` for
        ``"student_learning"``, ``prompts_everyday/observer.txt`` otherwise).
        All LLM calls go through ``external_api.llm.chat_completion``.
        """
        http_client = httpx.AsyncClient(timeout=120.0)
        return cls(
            http_client=http_client,
            tutor_url=tutor_url,
            ai_tutor_output_log=ai_tutor_output_log,
            snapshot_buffer_max_size=snapshot_buffer_max_size,
            observer_model=observer_model,
            scenario=scenario,
            memory_engine=memory_engine,
        )

    def set_memory_session(self, session_id: str | None) -> None:
        self._memory_session_id = session_id

    async def set_scenario(
        self, scenario: str, custom_observer_prompt: str | None = None
    ) -> None:
        """Switch the observer prompt to match the selected scenario and
        notify the tutor server so it reloads the correct prompts.

        ``"student_learning"`` → prompts_problem_solving/observer.txt
        ``"everyday_support"`` → prompts_everyday/observer.txt

        When ``custom_observer_prompt`` is provided (the user's "Custom" mode),
        it is written to a new file in the user-data dir and used as the observer
        prompt, overriding the scenario default. Only the OBSERVER is customized;
        the tutor server is still told the base ``scenario`` below so its
        diagnostic/tutor and the judge prompts load normally.
        """
        self._scenario = scenario
        if custom_observer_prompt:
            self._observer_prompt = _install_custom_observer_prompt(
                custom_observer_prompt
            )
            logger.info(
                "AiTutoringProcessor: using CUSTOM observer prompt "
                f"(base scenario={scenario!r})"
            )
        else:
            self._observer_prompt = _load_observer_prompt(scenario)
            logger.info(
                f"AiTutoringProcessor: observer prompt updated for scenario={scenario!r}"
            )
        # Forward the scenario to the tutor server so it loads the correct
        # diagnostic and tutor prompts (prompts_everyday vs prompts_problem_solving).
        try:
            resp = await self._http_client.post(
                f"{self.tutor_url}/config/scenario",
                json={"scenario": scenario},
            )
            resp.raise_for_status()
            logger.info(f"Tutor server scenario updated to {scenario!r}")
        except Exception as e:
            logger.warning(
                f"Could not update tutor server scenario to {scenario!r}: {e}"
            )

    def set_session_active(self, active: bool) -> None:
        """Mark whether a tutor session is currently running.

        When ``active`` is ``True``, the observer starts emitting
        ``task_complete`` signals and stops emitting ``task_suggested`` ones.
        When ``False``, the inverse applies and the suggestion cooldown resets
        so the user will be prompted again after the next idle interval.
        """
        self._session_active = active
        if not active:
            # Reset cooldown so the next observation cycle can suggest a
            # new session immediately once the user starts working again.
            self._last_suggestion_ts = 0.0
        logger.info(f"AiTutoringProcessor: session_active set to {active}")

    # ------------------------------------------------------------------
    # Observation broadcasting (SSE / live UI feed)
    # ------------------------------------------------------------------

    def subscribe_observations(self, maxsize: int = 100) -> asyncio.Queue:
        """Register a new subscriber and return its event queue.

        Each event is a dict ``{type, observation, ts, scenario}``. The queue
        is bounded; if a subscriber falls behind, oldest events are dropped so
        sensing is never blocked by slow consumers.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._obs_subscribers.append(q)
        return q

    def unsubscribe_observations(self, q: asyncio.Queue) -> None:
        if q in self._obs_subscribers:
            self._obs_subscribers.remove(q)

    def _broadcast_observation(
        self,
        type_: str,
        observation: str,
        observation_id: str | None = None,
        llm_metrics: dict | None = None,
        image_paths: list[str] | None = None,
    ) -> None:
        if not self._obs_subscribers:
            return
        # Pause / struggle events are mechanical signals that the user is stuck —
        # bypass the JSON classifier (the observation text for these may not even
        # be JSON, e.g. the prefixed "[Struggle trigger — …]" string from
        # ProgressDetector._fire).
        if type_ in ("pause", "struggle"):
            status = "stuck"
        else:
            status = _classify_observation_status(
                self._scenario, observation, session_active=self._session_active
            )

        # Extract a human-readable task label from every observation so the
        # Electron main process can show it in the "start a session?" prompt
        # without needing to parse the raw JSON itself.
        task_label = _extract_task_label(observation)

        # NOTE: the pre-session "task_suggested" invite is no longer decided here.
        # All proactive fires — invites (no active session) and in-chat nudges
        # (active session) — are now owned by the ProgressDetector judge, which
        # calls ``broadcast_invite`` when it decides to invite. This keeps a
        # single decision path and one set of timing/cooldown knobs.

        applying_ai_output = _extract_applying_ai_output(observation)

        event: dict = {
            "type": type_,
            "observation": observation,
            "status": status,
            "ts": time.time(),
            "scenario": self._scenario,
        }
        if observation_id:
            event["observation_id"] = observation_id
        if image_paths:
            event["image_paths"] = image_paths
        if llm_metrics is not None:
            event["llm_metrics"] = llm_metrics
        if task_label:
            event["task_label"] = task_label
        if applying_ai_output is not None:
            event["applying_ai_output"] = applying_ai_output

        for q in self._obs_subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop the oldest event to make room for the newest.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def broadcast_invite(
        self,
        observation: str,
        task_label: str,
        image_paths: list[str] | None = None,
    ) -> None:
        """Emit a pre-session invite as a ``task_suggested`` observation event.

        Called by the ProgressDetector when the judge decides to proactively
        speak up while no session is active. The Electron UI listens for
        ``status == "task_suggested"`` and shows the "start a session?" bubble.
        Firing/timing is owned by the judge, so there is no rate-limit here.
        """
        event = {
            "type": "invite",
            "observation": observation,
            "status": "task_suggested",
            "ts": time.time(),
            "scenario": self._scenario,
            "task_label": task_label,
        }
        if image_paths:
            event["image_paths"] = image_paths
        for q in self._obs_subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    # ------------------------------------------------------------------
    # Pause / struggle event broadcasting (SSE — consumed by tutor-worker)
    # ------------------------------------------------------------------

    def subscribe_pause(self, maxsize: int = 16) -> asyncio.Queue:
        """Register a new pause/struggle subscriber and return its queue.

        Each event is the same payload that used to be published to the Redis
        channel ``sensing/{node_uuid}/pause_detected`` — i.e. ``{"data": {...}}``.
        Bounded queue: if a subscriber falls behind, the oldest event is dropped
        so sensing is never blocked.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._pause_subscribers.append(q)
        return q

    def unsubscribe_pause(self, q: asyncio.Queue) -> None:
        if q in self._pause_subscribers:
            self._pause_subscribers.remove(q)

    def broadcast_pause(self, payload: dict) -> None:
        """Push a pause-event payload to every subscriber (drops on backpressure)."""
        for q in self._pause_subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    # ------------------------------------------------------------------
    # SegmentProcessor interface
    # ------------------------------------------------------------------

    async def process(
        self,
        segments: list | None = None,
        type: str | None = None,
        user_text: str | None = None,
        image_path: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        if type == "pause":
            await self._handle_pause(image_path=image_path, timestamp=timestamp)
        elif type == "user_prompt":
            await self._handle_user_prompt(
                user_text=user_text, image_path=image_path, timestamp=timestamp
            )
        elif type == "snapshot":
            await self._handle_snapshot(
                image_path=segments[-1][-1]["state_str"]["after"] if segments else None,
                timestamp=str(segments[-1][-1]["timestamp"]) if segments else None,
            )

    async def close(self) -> None:
        """Release the HTTP client."""
        await self._http_client.aclose()

    # ------------------------------------------------------------------
    # Public helpers (called by Streamer delegation methods)
    # ------------------------------------------------------------------

    async def generate_observation(
        self,
        type: str,
        user_text: str | None = None,
        image_path: str | None = None,
        timestamp: str | None = None,
        hotkey_image_paths: list[str] | None = None,
    ) -> tuple[str, LLMCallMetrics]:
        """Add an optional snapshot then generate and return an observation string.

        Called by ``sensing_server``'s ``/observe/user_prompt`` endpoint so
        that ``TutorAgentNode`` can retrieve observations without knowing about
        ``Streamer`` internals.

        ``hotkey_image_paths`` contains paths to user-flagged hot-key screenshots
        that should be shown to the observer alongside the current snapshot.
        These files are NOT deleted after the observation — they persist in the
        ``HotKeyBuffer`` for the duration of the session.
        """
        if image_path and timestamp:
            self._add_snapshot(image_path, timestamp)
        obs, _, metrics = await self._handle_observation(
            type=type, user_text=user_text, hotkey_image_paths=hotkey_image_paths
        )
        self._log(f"[{type.upper()} OBSERVATION (generate_observation)] {obs}\n")
        return obs, metrics

    async def configure_session(self) -> None:
        """Reset per-session observer state for a new tutor session.

        Called by ``Streamer.configure_session`` when the tutor-worker (or any
        caller) registers a session via ``POST /session``. Pause / struggle
        events themselves now go through ``broadcast_pause`` to local SSE
        subscribers — there's no Redis target to configure here anymore.
        """
        # Clear observation history so the observer LLM context starts fresh
        # for the new session rather than carrying over context from the previous one.
        self.snapshot_buffer.obs_history.clear()

        # Preserve recent observations (within the last 5 minutes) so the
        # session's first judge tick has immediate context — in particular, the
        # observation that triggered the session invitation is still valid signal
        # and should not be discarded.  Older entries are dropped to prevent
        # cross-session bleed.
        _RECENT_OBS_WINDOW_S: float = 5 * 60.0
        now = time.time()
        self._observation_history = deque(
            (
                e
                for e in self._observation_history
                if now - float(e.get("ts", 0)) < _RECENT_OBS_WINDOW_S
            ),
            maxlen=self._observation_history.maxlen,
        )
        logger.info(
            f"configure_session: retained {len(self._observation_history)} recent "
            "observation(s) from pre-session window for judge context"
        )

        # Tell the tutor server to wipe its per-session state so conversation
        # history and curriculum state don't carry over from the previous session.
        try:
            resp = await self._http_client.post(f"{self.tutor_url}/context/reset")
            resp.raise_for_status()
            logger.info("Tutor server session reset on new session registration")
        except Exception as e:
            logger.warning(
                f"Could not reset tutor server session state: {e}. "
                "Previous session's conversation history may persist."
            )

    async def set_problem_statement(self, problem_statement: str) -> None:
        """Forward a problem-statement update to the tutor server."""
        resp = await self._http_client.post(
            f"{self.tutor_url}/context/problem_statement",
            json={"problem_statement": problem_statement},
        )
        resp.raise_for_status()
        logger.info(
            f"Problem statement forwarded to tutor server: {problem_statement[:80]}..."
        )

    # ------------------------------------------------------------------
    # Internal event handlers
    # ------------------------------------------------------------------

    async def _handle_user_prompt(
        self,
        user_text: str | None,
        image_path: str | None,
        timestamp: str | None,
        hotkey_image_paths: list[str] | None = None,
    ) -> str:
        print(
            f"[HANDLE USER PROMPT] user_text: {user_text}, "
            f"image_path: {image_path}, timestamp: {timestamp}"
        )
        if image_path and timestamp:
            self._add_snapshot(image_path, timestamp)
        obs, _text, _metrics = await self._handle_observation(
            type="user_prompt",
            user_text=user_text,
            hotkey_image_paths=hotkey_image_paths,
        )
        self._log(f"[USER PROMPT OBSERVATION] {obs}\n")
        return obs

    async def _handle_snapshot(
        self,
        image_path: str | None,
        timestamp: str | None,
    ) -> None:
        # print(f"[HANDLE SNAPSHOT] image_path: {image_path}, timestamp: {timestamp}")
        if not image_path or not timestamp:
            return
        self._add_snapshot(image_path, timestamp)
        if len(self.snapshot_buffer.buffer) >= self.snapshot_buffer.max_size:
            obs, _text, _metrics = await self._handle_observation(type="snapshot")
            self._log(f"[SNAPSHOT OBSERVATION] {obs}\n")
            self.snapshot_buffer.obs_history.append(obs)
            self.snapshot_buffer.buffer.clear()

    async def _handle_pause(
        self,
        image_path: str | None,
        timestamp: str | None,
    ) -> None:
        print(f"[HANDLE PAUSE] image_path: {image_path}, timestamp: {timestamp}")
        if image_path and timestamp:
            self._add_snapshot(image_path, timestamp)
        obs, text, metrics = await self._handle_observation(type="pause")
        self._log(f"[PAUSE OBSERVATION] {obs}\n")

        payload = {
            "data": {
                "data_type": "pause_detected",
                "observation": obs,
                "text": text,
                "llm_metrics": metrics,
            }
        }
        self.broadcast_pause(payload)
        logger.info(
            f"Broadcast pause_detected to {len(self._pause_subscribers)} subscriber(s)"
        )

    # ------------------------------------------------------------------
    # Observation generation helpers
    # ------------------------------------------------------------------

    async def _handle_observation(
        self,
        user_text: str | None = None,
        type: str | None = None,
        hotkey_image_paths: list[str] | None = None,
    ) -> tuple[str, str, LLMCallMetrics]:
        from datetime import datetime as _dt

        text = await self._build_context_prompt()
        # In-context memory: recent observations + how the user reacted, so the
        # observer doesn't re-raise a suggestion the user just dismissed.
        recent_block = self._recent_observations_block(n=3)
        if recent_block:
            text += recent_block + "\n"
        now_ts = _dt.now().strftime("%Y-%m-%d %H:%M:%S")
        if type == "pause":
            text += f'<user_input timestamp="{now_ts}">(The user has been idle.)</user_input>'
        elif type == "user_prompt":
            text += f'<user_input timestamp="{now_ts}">{user_text or ""}</user_input>'
        elif type == "snapshot":
            text += f'<user_input timestamp="{now_ts}">(Periodic background snapshot)</user_input>'

        # Collect rolling snapshot images (these will be cleaned up after use).
        text_prompt, snapshot_image_paths = self._collect_images(text)

        # Append user-flagged hot-key screenshot(s) after the rolling snapshots.
        # We keep these paths separate so we do NOT delete them — they must
        # persist in the HotKeyBuffer for the rest of the session.
        hk_paths = hotkey_image_paths or []
        if hk_paths:
            hk_lines = "\n".join(
                f"  [hk{i + 1}] {path}" for i, path in enumerate(hk_paths)
            )
            text_prompt += (
                f'\n<screenshots type="hotkey">\n'
                f"The user explicitly flagged {len(hk_paths)} screenshot(s) using "
                f"the hot-key shortcut (Cmd+Shift+H). These represent the specific "
                f"UI state the user wants guidance on. Images appear after the "
                f"current-state snapshots in the order listed below.\n"
                f"{hk_lines}\n"
                f"</screenshots>"
            )

        all_image_paths = snapshot_image_paths + hk_paths

        observation_id = uuid.uuid4().hex
        obs, metrics = _observe(
            text_prompt,
            all_image_paths,
            system_prompt=self._observer_prompt,
            model=self._observer_model,
        )
        print(f"[HANDLE OBSERVATION] type: {type}, obs: {obs}")
        self._last_observation_id = observation_id

        # Record the observer call for training BEFORE cleanup, so screenshot
        # retention (when enabled) can copy the files the observer actually saw.
        if self._recorder is not None:
            self._recorder.log_observation(
                observation_id=observation_id,
                ts=time.time(),
                obs_type=type or "unknown",
                observer_input=text_prompt,
                observer_output=obs,
                model=self._observer_model,
                screenshot_paths=all_image_paths,
                llm_metrics=metrics,
            )

        # The observer's semantic output is the raw observation for long-term
        # GUM memory. Persist quickly; proposition work runs on MemoryEngine's
        # background task and never delays the live tutor path.
        if self._memory_engine is not None:
            try:
                await self._memory_engine.add_observation(
                    ObservationInput(
                        id=observation_id,
                        content=obs,
                        created_at=time.time(),
                        observation_type=type or "unknown",
                        session_id=self._memory_session_id,
                        scenario=self._scenario,
                    )
                )
            except Exception as exc:
                logger.warning(f"Could not persist observation to memory: {exc}")

        # Keep the newest rolling screenshot alive briefly so the desktop can
        # forward it to the eager instant-suggestion VLM call. Other rolling
        # screenshots can be removed immediately; hot-key screenshots already
        # have session-managed lifetimes.
        suggestion_image_paths = (
            snapshot_image_paths[-1:] if snapshot_image_paths else hk_paths[-1:]
        )
        self._last_observation_image_paths = suggestion_image_paths
        deferred_cleanup = set(suggestion_image_paths) & set(snapshot_image_paths)

        # Delete only the rolling snapshot files — the observer has already
        # base64-encoded them and they are no longer needed.
        # Hot-key screenshots are intentionally excluded from cleanup.
        self._cleanup_consumed_screenshots(
            [path for path in snapshot_image_paths if path not in deferred_cleanup]
        )
        if deferred_cleanup:
            asyncio.get_running_loop().call_later(
                60,
                self._cleanup_consumed_screenshots,
                list(deferred_cleanup),
            )

        # Record for the progress judge's rolling history. Skip "pause" and
        # "progress_check" events — "pause" is triggered by the judge itself
        # and would feed back; "progress_check" is the judge's own fresh
        # snapshot observation and should not pollute the history buffer.
        if type not in ("pause", "progress_check"):
            self._observation_history.append(
                {
                    "ts": time.time(),
                    "type": type or "unknown",
                    "obs": obs,
                    "observation_id": observation_id,
                }
            )

        # Broadcast to live subscribers (e.g. the Electron avatar UI). Carries
        # the observation_id so the UI can echo it back in feedback (engage /
        # dismiss) and we can join the reaction to this exact observation.
        self._broadcast_observation(
            type or "unknown",
            obs,
            observation_id=observation_id,
            llm_metrics=metrics,
            image_paths=suggestion_image_paths,
        )
        return obs, text, metrics

    @staticmethod
    def _cleanup_consumed_screenshots(image_paths: list[str]) -> None:
        """Delete screenshot files that have been consumed by the observer.

        Called after ``_observe()`` returns so the files are no longer needed.
        Errors are silently ignored — the files may have already been removed
        by another cleanup path (e.g. keyboard session optimization).
        """
        for path in image_paths:
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except OSError:
                pass

    def recent_observations(self, n: int = 5) -> list[dict]:
        """Return up to the last ``n`` observer outputs, oldest-first."""
        if n <= 0:
            return []
        items = list(self._observation_history)
        return items[-n:]

    # Terminal reactions (an explicit accept/decline) outrank a plain "shown".
    _TERMINAL_REACTIONS = (
        "engage",
        "dismiss",
        "need_help",
        "thumbs_up",
        "thumbs_down",
    )

    def record_reaction(self, observation_id: str | None, kind: str) -> None:
        """Record the user's reaction to a specific observation (from /feedback).

        A later ``shown`` never overwrites an explicit accept/decline already
        recorded for the same observation.
        """
        if not observation_id or not kind:
            return
        prev = self._reactions.get(observation_id)
        if kind == "shown" and prev in self._TERMINAL_REACTIONS:
            return
        self._reactions[observation_id] = kind
        # Bound memory — drop oldest insertions if the map grows large.
        while len(self._reactions) > 200:
            self._reactions.pop(next(iter(self._reactions)))

    _REACTION_LABEL = {
        "engage": "user ACCEPTED (clicked 'Help me with this')",
        "dismiss": "user DISMISSED this suggestion",
        "need_help": "user ASKED FOR HELP despite this calm status — a MISSED need (you under-called here)",
        "shown": "shown to user — no response (ignored)",
        "thumbs_up": "user rated the resulting help 👍",
        "thumbs_down": "user rated the resulting help 👎",
    }

    def _recent_observations_block(self, n: int = 3) -> str:
        """Build an in-context block of the last ``n`` observations + reactions.

        Lets the observer avoid re-raising a suggestion the user just dismissed.
        Returns an empty string when there is no prior observation.
        """
        recent = self.recent_observations(n)
        if not recent:
            return ""
        now = time.time()
        lines = [
            "<recent_observations>",
            "Your last few observations and how the user reacted to the bubble each "
            "one triggered. Do NOT re-raise a suggestion the user just DISMISSED "
            "unless the situation has materially changed — for the same ongoing "
            'activity, prefer a calmer status ("progress"/"observing") instead of '
            'repeating an "inefficient"/"mistake"/"stuck" flag.',
        ]
        for i, entry in enumerate(recent, start=1):
            age = max(0.0, now - float(entry.get("ts", now)))
            oid = entry.get("observation_id")
            reaction = self._reactions.get(oid or "")
            label = self._REACTION_LABEL.get(reaction, "no feedback recorded")  # type: ignore
            lines.append(f"[{i}] t-{age:.0f}s  reaction={label}")
            lines.append(f"    {str(entry.get('obs', '')).strip()}")
        lines.append("</recent_observations>")
        return "\n".join(lines)

    async def _build_context_prompt(self) -> str:
        """Fetch conversation history and problem statement from the tutor server.

        Conversation history is only included when a session is active — pre-session
        observers (used for task-suggestion notifications) should not see conversation
        history from a previous session because no new session has been registered yet
        and the tutor server may still hold stale state.
        """
        try:
            resp = await self._http_client.get(f"{self.tutor_url}/context")
            resp.raise_for_status()
            data = resp.json()
            problem = data.get("problem_statement", "")
            memory = data.get("memory", "")
            # Only inject conversation history once a session is running; pre-session
            # observations are purely screen-based and must not carry over old chat.
            conv = data.get("conversation_history", []) if self._session_active else []
        except Exception as e:
            logger.warning(
                f"Could not reach tutor server for context: {e}. Using empty context."
            )
            conv, problem, memory = [], "", ""

        conv_block = "\n".join(conv) if conv else "(no conversation history yet)"
        # Student-tutoring scenarios carry a real problem the user is solving; the
        # worker/everyday product scenarios instead carry long-term personalized
        # memory (empty until a personalization/self-evolvement layer fills it).
        if self._scenario in ("student_learning", "cs224n"):
            ctx_block = f"<problem_statement>\n{problem}\n</problem_statement>"
        else:
            ctx_block = f"<memory>\n{memory or '(no memory yet)'}\n</memory>"
        return (
            f"{ctx_block}\n\n"
            f"<conversation_history>\n{conv_block}\n</conversation_history>\n\n"
        )

    def _collect_images(self, text_prompt: str) -> tuple[str, list[str]]:
        if self.snapshot_buffer.obs_history:
            obs_joined = "\n".join(self.snapshot_buffer.obs_history)
            text_prompt += (
                f"\n<previous_observations>\n{obs_joined}\n</previous_observations>\n"
            )
            self.snapshot_buffer.obs_history.clear()
        n = self._image_num
        snaps = self.snapshot_buffer.history(n)
        if snaps:
            snap_lines = "\n".join(
                f"  [{s.timestamp}] Screenshot {i + 1} of {len(snaps)}"
                for i, s in enumerate(snaps)
            )
            text_prompt += (
                f"\n<screenshots>\n{snap_lines}\n"
                "Images follow this text in the order listed above.\n"
                "</screenshots>\n"
            )
        image_paths = [s.image_path for s in snaps]
        self.snapshot_buffer.buffer.clear()
        self._image_num = 0
        return text_prompt, image_paths

    def _add_snapshot(self, image_path: str, timestamp: str) -> None:
        # print(f"[ADD SNAPSHOT] image_path: {image_path}, timestamp: {timestamp}")
        self.snapshot_buffer.add_snapshot(image_path, timestamp)
        self._image_num += 1
        self._log(f"[SNAPSHOT BUFFER] Added snapshot {image_path} at {timestamp}\n")

    def _log(self, msg: str) -> None:
        if self.ai_tutor_output_log:
            with open(self.ai_tutor_output_log, "a") as f:
                f.write(msg)
