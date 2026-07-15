"""Progress / struggle detection for the sensing module.

Complements the existing pause detection (mechanical: no input activity) with
a *semantic* check on whether the user is making meaningful progress on their
stated task. Even a fully-engaged on-task user can be stuck — repeating the
same failing command, going in circles between the same files, or staring at
the same error. When sustained struggle is detected, we publish a
``pause_detected`` event with ``trigger_reason="struggle"`` so TutorAgentNode
can forward it to the tutor server as a proactive nudge — re-using the pause
channel keeps the MVP small; a dedicated channel can be split out later once
we have data.

Design (see conversation / plan doc for context):
    • Runs on a configurable cadence (unified with pause detection interval).
    • Each tick: observer history + problem statement + conversation → judge LLM.
    • K consecutive struggle judgments trigger a nudge (default K=1).
    • Post-fire cooldown prevents nudge-spam (default 2 min).
    • Session-start grace period avoids interrupting setup (default 10s).
    • Logs every judgment for later calibration.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from py_utils.logging import init_logger

if TYPE_CHECKING:
    from sensing.screen import Screen
    from sensing.segment_processor import AiTutoringProcessor

logger = init_logger(__name__)


# ---------------------------------------------------------------------------
# Judge prompt
# ---------------------------------------------------------------------------


def _extract_applying_ai_output(obs_text: str) -> str | None:
    """Pull the 'applying_ai_output' field from an observer JSON string.

    Returns "yes", "no", or None if the field is absent or the text is not JSON.
    """
    if not obs_text:
        return None
    # Find the first JSON object.
    brace = re.search(r"\{.*\}", obs_text, re.DOTALL)
    if not brace:
        return None
    try:
        obj = json.loads(brace.group(0))
        val = str(obj.get("applying_ai_output", "")).strip().lower()
        return val if val in ("yes", "no") else None
    except Exception:
        return None


def _load_judge_prompt(scenario: str = "everyday_support") -> str:
    """Load the judge prompt for the given scenario.

    ``"student_learning"`` → prompts_problem_solving/judge.txt
    Any other value (including ``"everyday_support"``) → prompts_everyday/judge.txt
    """
    prompt_dir = {
        "student_learning": "prompts_problem_solving",
    }.get(scenario, "prompts_everyday")
    return (Path(__file__).parent / prompt_dir / "judge.txt").read_text()


_JUDGE_PROMPT: str = _load_judge_prompt()


def _lenient_json_loads(text: str) -> dict | None:
    """Best-effort JSON parser for LLM output.

    Tries strict ``json.loads`` first, then progressively cleans common LLM
    quirks (trailing commas, Python-style ``True``/``False``/``None``,
    single-quoted strings) and retries. Returns ``None`` if it still cannot
    parse — caller decides the fallback behavior.
    """
    if not text:
        return None

    # 1. Strict parse
    try:
        return json.loads(text)
    except Exception:
        pass

    cleaned = text

    # 2. Strip trailing commas before } or ]
    cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)

    # 3. Python-style booleans/None → JSON
    cleaned = re.sub(r"\bTrue\b", "true", cleaned)
    cleaned = re.sub(r"\bFalse\b", "false", cleaned)
    cleaned = re.sub(r"\bNone\b", "null", cleaned)

    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # 4. Replace single quotes around keys/strings with double quotes.
    # Naive but effective for typical LLM output that doesn't itself contain
    # apostrophes inside strings.
    try:
        return json.loads(cleaned.replace("'", '"'))
    except Exception:
        return None


def _salvage_truncated_judgment(text: str) -> dict | None:
    """Extract recognizable primitive fields from a truncated judge response.

    Last resort when the LLM ran out of tokens mid-emission (typically inside
    the ``evidence`` string). Pulls ``making_progress``, ``confidence``,
    ``struggle_category``, and ``should_intervene`` via regex if present.
    Returns ``None`` if not even ``making_progress`` could be recovered.
    """
    out: dict = {}
    m = re.search(r'"making_progress"\s*:\s*(true|false)', text, re.IGNORECASE)
    if m:
        out["making_progress"] = m.group(1).lower() == "true"
    m = re.search(r'"confidence"\s*:\s*([0-9.]+)', text)
    if m:
        try:
            out["confidence"] = float(m.group(1))
        except ValueError:
            pass
    m = re.search(r'"struggle_category"\s*:\s*"([^"]+)"', text)
    if m:
        out["struggle_category"] = m.group(1)
    m = re.search(r'"should_intervene"\s*:\s*(true|false)', text, re.IGNORECASE)
    if m:
        out["should_intervene"] = m.group(1).lower() == "true"
    # If we recovered a struggle verdict with no explicit should_intervene,
    # default to True so the streak counter advances — matching what a fully-
    # formed struggle judgment would have implied.
    if (
        "making_progress" in out
        and not out["making_progress"]
        and "should_intervene" not in out
    ):
        out["should_intervene"] = True
    return out if "making_progress" in out else None


@dataclass
class ProgressJudgment:
    """Structured result from the judge LLM.

    ``making_progress=True`` means the user appears to be moving forward on the
    task (typing, navigating intentionally, researching). ``False`` means they
    look stuck — repeating the same actions, going in circles, or staring at an
    error — even if they are nominally on-task. ``should_intervene`` is a
    stricter signal that the struggle is sustained enough to warrant a nudge.
    """

    making_progress: bool = True
    confidence: float = 0.0
    struggle_category: str = "none"
    evidence: str = ""
    should_intervene: bool = False
    trigger_type: str = "struggle"  # "struggle" | "inefficiency" | "blind_acceptance"
    # | "framework_introduction" | "teaching_moment"
    # | "discernment_opportunity"
    teaching_depth: str = (
        "not_applicable"  # "introduce" | "reinforce" | "deepen" | "not_applicable"
    )
    raw: str = ""  # unparsed LLM output, for logs

    @classmethod
    def from_llm_output(cls, text: str) -> ProgressJudgment:
        """Parse judge LLM JSON output. Be lenient about stray prose/fences."""
        raw = text.strip()
        # Strip markdown fence if present
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
        json_text = fence_match.group(1) if fence_match else raw

        # Fall back to first {...} block
        if not json_text.startswith("{"):
            brace_match = re.search(r"\{.*\}", json_text, re.DOTALL)
            if brace_match:
                json_text = brace_match.group(0)

        obj = _lenient_json_loads(json_text)
        if obj is None:
            # Salvage path: output was likely truncated mid-string.
            salvaged = _salvage_truncated_judgment(json_text)
            if salvaged:
                logger.warning(
                    f"ProgressJudgment: JSON unparseable, salvaged partial fields "
                    f"{salvaged} from truncated output. Raw: {raw[:300]!r}"
                )
                obj = salvaged
            else:
                logger.warning(
                    f"ProgressJudgment: failed to parse LLM output even after cleanup; "
                    f"defaulting to making_progress=true. Raw: {raw[:300]!r}"
                )
                return cls(making_progress=True, raw=raw)

        return cls(
            making_progress=bool(obj.get("making_progress", True)),
            confidence=float(obj.get("confidence", 0.0)),
            struggle_category=str(obj.get("struggle_category", "none")),
            evidence=str(obj.get("evidence", "")),
            should_intervene=bool(obj.get("should_intervene", False)),
            trigger_type=str(obj.get("trigger_type", "struggle")),
            teaching_depth=str(obj.get("teaching_depth", "not_applicable")),
            raw=raw,
        )


# ---------------------------------------------------------------------------
# ProgressDetector
# ---------------------------------------------------------------------------


@dataclass
class ProgressDetectorConfig:
    check_interval_seconds: float = 120.0
    # How long to wait before the very first judge tick after session start.
    # Intentionally shorter than check_interval_seconds so the first coaching
    # opportunity is spotted quickly rather than after a full interval wait.
    first_tick_delay_seconds: float = 30.0
    # Retained for backward-compat with older /session requests. The text-only
    # judge is temporally aware across observer reports, so K-consecutive
    # counting is no longer used internally unless k_threshold > 1.
    k_threshold: int = 1
    post_fire_cooldown_seconds: float = 120.0
    # Grace period before any tick is allowed to fire. Set to less than
    # first_tick_delay_seconds so the first tick always passes this check.
    session_start_grace_seconds: float = 15.0
    enabled: bool = True
    # Number of recent observer reports to include in the judge prompt.
    max_observations_in_prompt: int = 5


class ProgressDetector:
    """Periodic semantic check for whether the user is struggling to make progress.

    Parameters
    ----------
    ai_processor
        The ``AiTutoringProcessor`` that owns the snapshot buffer, observer
        model, redis publisher, problem statement, and conversation history.
        ProgressDetector re-uses its infrastructure rather than owning its own
        copies.
    screen
        The ``Screen`` instance used to capture a fresh screenshot on each
        tick (via its ``_inspect()`` coroutine). Also queried for the last
        active click timestamp so we skip ticks when a pause is clearly in
        progress (pause detector supersedes us).
    streamer
        The ``Streamer`` used to fetch recent actions from in-memory storage.
    log_path
        Where to append judgment logs (JSONL, one per tick).
    """

    def __init__(
        self,
        ai_processor: AiTutoringProcessor,
        screen: Screen,
        streamer,
        log_path: str = "logs/progress_judgments.jsonl",
        config: ProgressDetectorConfig | None = None,
        scenario: str = "everyday_support",
    ) -> None:
        self._ai_processor = ai_processor
        self._screen = screen
        self._streamer = streamer
        self._log_path = log_path
        self._config = config or ProgressDetectorConfig()
        self._scenario: str = scenario
        self._judge_prompt: str = _load_judge_prompt(scenario)

        self._running = False
        self._task: asyncio.Task | None = None
        self._start_ts: float = 0.0
        self._last_fire_ts: float = 0.0
        self._consecutive_struggle: int = 0
        self._lock = asyncio.Lock()
        self._reset_event: asyncio.Event | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._task is not None:
            return
        self._running = True
        self._start_ts = time.time()
        self._last_fire_ts = 0.0
        self._consecutive_struggle = 0
        self._reset_event = asyncio.Event()
        self._task = asyncio.create_task(self._worker())
        logger.info(
            f"ProgressDetector started: first_tick={self._config.first_tick_delay_seconds}s "
            f"interval={self._config.check_interval_seconds}s "
            f"k={self._config.k_threshold} cooldown={self._config.post_fire_cooldown_seconds}s "
            f"grace={self._config.session_start_grace_seconds}s"
        )

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    def reset_cooldown(self) -> None:
        """Reset the post-fire cooldown as if a nudge was just sent.

        Called when guidance is delivered to the user (from any source —
        pause, struggle, or user-initiated) so the progress detector doesn't
        immediately fire a redundant nudge.
        """
        self._last_fire_ts = time.time()
        self._consecutive_struggle = 0
        logger.info("ProgressDetector: cooldown reset (guidance delivered)")

    def reset_timing(self) -> None:
        """Restart the tick interval from now.

        Called when the user submits a text prompt to the tutor so the
        progress detector doesn't fire immediately after they've just engaged.
        """
        if self._reset_event is not None:
            self._reset_event.set()
        logger.info("ProgressDetector: timing reset (user sent a prompt)")

    def update_config(self, **kwargs) -> None:
        """Update config fields in place (e.g. from a /session request)."""
        for k, v in kwargs.items():
            if hasattr(self._config, k) and v is not None:
                setattr(self._config, k, v)

    def set_scenario(self, scenario: str) -> None:
        """Switch the judge prompt to match the selected scenario.

        ``"student_learning"`` → prompts_problem_solving/judge.txt
        ``"everyday_support"`` → prompts_everyday/judge.txt
        """
        self._scenario = scenario
        self._judge_prompt = _load_judge_prompt(scenario)
        logger.info(f"ProgressDetector: judge prompt updated for scenario={scenario!r}")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def _worker(self) -> None:
        reset_event = self._reset_event
        assert reset_event is not None, (
            "_worker started before reset_event was initialized"
        )
        try:
            first_tick = True
            while self._running:
                try:
                    delay = (
                        self._config.first_tick_delay_seconds
                        if first_tick
                        else self._config.check_interval_seconds
                    )
                    first_tick = False
                    # Interruptible sleep: reset_timing() can cancel the current
                    # interval early so the next tick restarts from a fresh delay.
                    try:
                        await asyncio.wait_for(reset_event.wait(), timeout=delay)
                        # Event fired — user sent a prompt; restart the interval.
                        reset_event.clear()
                        first_tick = True
                        continue
                    except TimeoutError:
                        pass  # Normal timeout — proceed to tick.
                    if not self._config.enabled:
                        continue
                    async with self._lock:
                        await self._tick()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"ProgressDetector tick failed: {e}", exc_info=True)
        except asyncio.CancelledError:
            pass

    async def _tick(self) -> None:
        now = time.time()
        logger.info(
            f"ProgressDetector: tick fired "
            f"(elapsed={now - self._start_ts:.0f}s since start, "
            f"since_last_fire={now - self._last_fire_ts:.0f}s)"
        )

        # 1. Grace period after session start
        elapsed = now - self._start_ts
        if elapsed < self._config.session_start_grace_seconds:
            logger.info(
                f"ProgressDetector: skipping tick — grace period "
                f"({elapsed:.0f}s elapsed < {self._config.session_start_grace_seconds}s grace)"
            )
            return

        # 2. Post-fire cooldown
        cooldown_remaining = self._config.post_fire_cooldown_seconds - (
            now - self._last_fire_ts
        )
        if cooldown_remaining > 0:
            logger.info(
                f"ProgressDetector: skipping tick — post-fire cooldown "
                f"({cooldown_remaining:.0f}s remaining)"
            )
            return

        logger.info(
            f"ProgressDetector: running tick "
            f"(elapsed={elapsed:.0f}s, consecutive_struggle={self._consecutive_struggle})"
        )

        # 3. Gather context. All proactive fires go through this one judge:
        #    when a session is active the fire becomes an in-chat nudge; when
        #    none is active it becomes an invite to start one. So pre-session we
        #    do NOT require a problem statement — the judge decides whether the
        #    current activity is worth proactively offering help for.
        session_active = getattr(self._ai_processor, "_session_active", False)
        if session_active:
            (
                problem_statement,
                conversation_history,
                curriculum_state,
                competency_counts,
            ) = await self._get_context()
            if not problem_statement:
                logger.info(
                    "ProgressDetector: skipping tick — no problem statement available from tutor /context"
                )
                return
        else:
            # Pre-session (invite mode): no problem statement / conversation yet.
            problem_statement = (
                "(No active session yet. The user has not opted into help. Decide "
                "whether the current activity is a clearly valuable moment to "
                "proactively offer assistance — if so, set should_intervene=true and "
                "this will invite the user to start a session. Hold a higher bar than "
                "for an ongoing session, since an unsolicited invite is more costly.)"
            )
            conversation_history, curriculum_state, competency_counts = [], {}, {}

        # 4. Pull the rolling observer-output buffer from the AI processor.
        recent_obs = self._ai_processor.recent_observations(
            self._config.max_observations_in_prompt
        )
        if not recent_obs:
            logger.info(
                "ProgressDetector: skipping tick — no observer reports in history yet"
            )
            return

        # 5. Capture a fresh observation of the current screen state so the
        #    judge always has an up-to-date anchor rather than reasoning purely
        #    over a potentially stale history buffer.  Errors are non-fatal —
        #    we fall back to history-only if the screenshot or observer fails.
        fresh_obs: str = ""
        fresh_observation_id: str | None = None
        try:
            image_path, timestamp = await self._screen._inspect()
            if image_path:
                self._ai_processor._add_snapshot(image_path, timestamp)
                fresh_obs, _, _ = await self._ai_processor._handle_observation(
                    type="progress_check"
                )
                # The observer stamps each call with an id; grab the fresh one so
                # the decision row can point back at the observation it anchored on.
                fresh_observation_id = getattr(
                    self._ai_processor, "_last_observation_id", None
                )
                logger.debug("ProgressDetector: fresh observation captured for tick")
        except Exception as e:
            logger.debug(f"ProgressDetector: could not capture fresh observation: {e}")

        # observation_ids for the rolling history window the judge will see.
        history_observation_ids = [
            e.get("observation_id") for e in recent_obs if e.get("observation_id")
        ]

        # For an invite (no active session) we need a task label for the
        # "start a session?" prompt — pull it from the fresh observation.
        task_label: str | None = None
        if not session_active and fresh_obs:
            from sensing.segment_processor import _extract_task_label  # avoid cycle

            task_label = _extract_task_label(fresh_obs)

        # 6. Build prompt and ask the judge.
        user_text = self._build_judge_user_prompt(
            problem_statement=problem_statement,
            recent_observations=recent_obs,
            conversation_history=conversation_history,
            now=now,
            fresh_obs=fresh_obs,
            curriculum_state=curriculum_state,
            competency_counts=competency_counts,
        )
        judgment = await asyncio.to_thread(self._run_judge, user_text)

        # 7. Log and (maybe) fire.
        decision_id = uuid.uuid4().hex
        self._log_judgment(now, judgment, image_path="", user_text=user_text)
        self._record_decision(
            decision_id=decision_id,
            now=now,
            judgment=judgment,
            judge_input=user_text,
            fresh_observation_id=fresh_observation_id,
            history_observation_ids=history_observation_ids,
            phase="nudge" if session_active else "invite",
        )
        await self._apply_judgment(
            now,
            judgment,
            image_path="",
            timestamp=None,
            decision_id=decision_id,
            session_active=session_active,
            task_label=task_label,
            fresh_obs=fresh_obs,
        )

    # ------------------------------------------------------------------
    # Context assembly
    # ------------------------------------------------------------------

    async def _get_context(self) -> tuple[str, list, dict, dict]:
        """Fetch problem statement, conversation history, and curriculum state from the tutor server."""
        try:
            resp = await self._ai_processor._http_client.get(
                f"{self._ai_processor.tutor_url}/context"
            )
            resp.raise_for_status()
            data = resp.json()
            problem = str(data.get("problem_statement", "")).strip()
            conv = data.get("conversation_history", []) or []
            curriculum_state = data.get("curriculum_state", {}) or {}
            competency_counts = data.get("competency_counts", {}) or {}
            return problem, conv, curriculum_state, competency_counts
        except Exception as e:
            logger.debug(f"ProgressDetector: could not fetch tutor context: {e}")
            return "", [], {}, {}

    def _build_judge_user_prompt(
        self,
        problem_statement: str,
        recent_observations: list[dict],
        conversation_history: list,
        now: float,
        fresh_obs: str = "",
        curriculum_state: dict | None = None,
        competency_counts: dict | None = None,
    ) -> str:
        lines = []

        lines.append(f"<problem_statement>\n{problem_statement}\n</problem_statement>")
        lines.append("")

        # Curriculum state — tells the worker-upskilling judge what 4D concepts
        # have already been taught (framework_introduction only fires once, etc.).
        # Only the ai_upskilling scenario uses the 4D curriculum; student_learning
        # and everyday_support judges have no curriculum logic.
        if self._scenario == "ai_upskilling":
            cs = curriculum_state or {}
            cc = competency_counts or {}
            lines.append(
                "<curriculum_state>\n"
                f"  framework_introduced: {cs.get('framework_introduced', False)}\n"
                f"  delegation_introduced: {cs.get('delegation_introduced', False)}\n"
                f"  description_introduced: {cs.get('description_introduced', False)}\n"
                f"  discernment_introduced: {cs.get('discernment_introduced', False)}\n"
                f"  diligence_introduced: {cs.get('diligence_introduced', False)}\n"
                "</curriculum_state>"
            )
            lines.append(
                "<recurrence_counts>\n"
                f"  delegation: {cc.get('delegation', 0)}\n"
                f"  description: {cc.get('description', 0)}\n"
                f"  discernment: {cc.get('discernment', 0)}\n"
                f"  diligence: {cc.get('diligence', 0)}\n"
                "</recurrence_counts>"
            )
            lines.append("")

        # Fresh observation captured right now — gives the judge an up-to-date
        # anchor on what the user is currently doing.
        if fresh_obs:
            from datetime import datetime as _dt

            current_ts = _dt.now().strftime("%Y-%m-%d %H:%M:%S")
            lines.append(
                f'<current_state timestamp="{current_ts}">\n{fresh_obs.strip()}\n</current_state>'
            )
            lines.append("")

        # Historical buffer — oldest first so the judge can see the trend over
        # time. Timestamps show how long ago each observation was made so the
        # judge can weigh recency appropriately (e.g. a struggle from 3 minutes
        # ago followed by active progress now should not trigger a nudge).
        obs_lines = []
        for i, entry in enumerate(recent_observations, start=1):
            age = max(0.0, now - float(entry.get("ts", now)))
            obs_text = entry.get("obs", "").strip()
            # Include applying_ai_output signal if present in the observer JSON.
            applying_ai = _extract_applying_ai_output(obs_text)
            applying_note = f" applying_ai_output={applying_ai}" if applying_ai else ""
            obs_lines.append(
                f"[{i}] t-{age:.0f}s  type={entry.get('type', 'unknown')}{applying_note}\n"
                f"    {obs_text}"
            )
        obs_block = "\n".join(obs_lines) if obs_lines else "(none)"
        lines.append(f"<observation_history>\n{obs_block}\n</observation_history>")
        lines.append("")

        if conversation_history:
            # Keep only the tail to bound prompt size.
            tail = conversation_history[-6:]
            conv_block = "\n".join(tail)
        else:
            conv_block = "(no conversation history yet)"
        lines.append(f"<conversation_history>\n{conv_block}\n</conversation_history>")
        lines.append("")

        lines.append("Now produce your JSON judgment.")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Judge call
    # ------------------------------------------------------------------

    def _run_judge(self, user_prompt: str) -> ProgressJudgment:
        """Blocking text-only judge call; invoked via asyncio.to_thread.

        Re-uses ``_observe`` with an empty image list so we stay within one
        LLM provider surface. No screenshot is sent — the judge reasons over
        the observer-output history only.
        """
        from sensing.segment_processor import _observe  # late import to avoid cycle

        try:
            raw, _ = _observe(
                text_prompt=user_prompt,
                image_paths=[],
                system_prompt=self._judge_prompt,
                model=self._ai_processor._observer_model,
                # Text-only call; budget still generous for thinking tokens.
                max_tokens=4096,
            )
        except Exception as e:
            logger.warning(f"ProgressDetector: judge LLM call failed: {e}")
            return ProgressJudgment(making_progress=True, raw=f"ERROR: {e}")
        return ProgressJudgment.from_llm_output(raw)

    # ------------------------------------------------------------------
    # Decision logic + firing
    # ------------------------------------------------------------------

    async def _apply_judgment(
        self,
        now: float,
        judgment: ProgressJudgment,
        image_path: str,
        timestamp: str | None,
        decision_id: str | None = None,
        session_active: bool = True,
        task_label: str | None = None,
        fresh_obs: str = "",
    ) -> None:
        # The judge reasons over an observation-history window, so it is
        # already temporally aware — a single should_intervene=True verdict
        # is sufficient to fire. K-threshold >1 is retained only as an
        # explicit opt-in safety rail.
        if not judgment.should_intervene:
            if self._consecutive_struggle > 0:
                logger.info(
                    f"ProgressDetector: intervention streak reset "
                    f"(was {self._consecutive_struggle}, making_progress={judgment.making_progress})"
                )
            self._consecutive_struggle = 0
            return

        self._consecutive_struggle += 1
        if self._consecutive_struggle < self._config.k_threshold:
            logger.info(
                f"ProgressDetector: struggle tick {self._consecutive_struggle}/"
                f"{self._config.k_threshold} — {judgment.evidence}"
            )
            return

        if session_active:
            logger.info(
                f"ProgressDetector: firing nudge "
                f"(trigger_type={judgment.trigger_type}) — {judgment.evidence}"
            )
            await self._fire(judgment, image_path, timestamp, decision_id=decision_id)
        else:
            logger.info(
                f"ProgressDetector: firing invite "
                f"(trigger_type={judgment.trigger_type}) — {judgment.evidence}"
            )
            await self._fire_invite(
                judgment, task_label, fresh_obs, decision_id=decision_id
            )
        self._last_fire_ts = now
        self._consecutive_struggle = 0

    async def _fire(
        self,
        judgment: ProgressJudgment,
        image_path: str,
        timestamp: str | None,
        decision_id: str | None = None,
    ) -> None:
        """Publish a pause_detected event with the judgment's trigger_type."""
        ai = self._ai_processor

        # Add the snapshot so _handle_observation has visual context
        if image_path and timestamp:
            ai._add_snapshot(image_path, timestamp)

        # Reuse the observer to build a rich observation (same as pause)
        try:
            obs, text, metrics = await ai._handle_observation(type="pause")
        except Exception as e:
            logger.error(f"ProgressDetector: observer failed during fire: {e}")
            obs = f"Struggle detected: {judgment.evidence}"
            text = obs
            metrics = None

        # Prepend human-readable evidence to the observation so downstream
        # prompts and logs explain *why* we spoke up (transparency).
        transparency_prefix = f"[{judgment.trigger_type} trigger — {judgment.struggle_category}] {judgment.evidence}\n\n"
        obs = transparency_prefix + obs

        # Surface the struggle to live UI subscribers (e.g. the Electron avatar
        # bubble) tagged as "struggle" so it's visually distinct from a plain
        # pause and carries the prefixed transparency text.
        ai._broadcast_observation("struggle", obs, llm_metrics=metrics)

        payload = {
            "data": {
                "data_type": "pause_detected",
                "observation": obs,
                "text": text,
                "trigger_reason": judgment.trigger_type,
                "evidence": judgment.evidence,
                "teaching_depth": judgment.teaching_depth,
            }
        }
        ai.broadcast_pause(payload)
        logger.info(
            f"ProgressDetector: fired nudge — trigger_type={judgment.trigger_type} "
            f"category={judgment.struggle_category} evidence={judgment.evidence!r}"
        )

        recorder = getattr(self._ai_processor, "_recorder", None)
        if recorder is not None and decision_id is not None:
            recorder.log_episode(
                decision_id=decision_id,
                ts=time.time(),
                trigger_reason=judgment.trigger_type,
                evidence=judgment.evidence,
                struggle_category=judgment.struggle_category,
                observation=obs,
                phase="nudge",
            )

    async def _fire_invite(
        self,
        judgment: ProgressJudgment,
        task_label: str | None,
        fresh_obs: str,
        decision_id: str | None = None,
    ) -> None:
        """Surface a pre-session INVITE: prompt the user to start a session.

        Unlike ``_fire`` (which goes through the tutor to produce in-chat
        guidance), an invite has no session/tutor context yet — it emits a
        ``task_suggested`` observation event that the Electron UI turns into a
        "want me to help?" bubble. Accepting it starts a session through the
        normal flow, so conversation history / memory are managed as usual.
        """
        ai = self._ai_processor
        obs = fresh_obs or judgment.evidence
        label = task_label
        if not label:
            from sensing.segment_processor import _extract_task_label  # avoid cycle

            label = _extract_task_label(obs) or "working on something"

        ai.broadcast_invite(observation=obs, task_label=label)
        logger.info(
            f"ProgressDetector: fired INVITE — task_label={label!r} "
            f"evidence={judgment.evidence!r}"
        )

        recorder = getattr(ai, "_recorder", None)
        if recorder is not None and decision_id is not None:
            recorder.log_episode(
                decision_id=decision_id,
                ts=time.time(),
                trigger_reason=judgment.trigger_type,
                evidence=judgment.evidence,
                struggle_category=judgment.struggle_category,
                observation=obs,
                phase="invite",
            )

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _record_decision(
        self,
        decision_id: str,
        now: float,
        judgment: ProgressJudgment,
        judge_input: str,
        fresh_observation_id: str | None,
        history_observation_ids: list,
        phase: str = "nudge",
    ) -> None:
        """Write the enriched, observer-linked decision row for training.

        Unlike ``_log_judgment`` (the legacy flat progress_judgments.jsonl), this
        carries timing/firing-policy context and references the observation_ids
        the judge reasoned over, so the observer and judge can be optimized
        jointly offline.
        """
        recorder = getattr(self._ai_processor, "_recorder", None)
        if recorder is None:
            return
        timing = {
            "since_start_s": round(now - self._start_ts, 1),
            "since_last_fire_s": round(now - self._last_fire_ts, 1),
            "consecutive_struggle": self._consecutive_struggle,
        }
        config = {
            "check_interval_s": self._config.check_interval_seconds,
            "first_tick_delay_s": self._config.first_tick_delay_seconds,
            "k_threshold": self._config.k_threshold,
            "post_fire_cooldown_s": self._config.post_fire_cooldown_seconds,
            "session_start_grace_s": self._config.session_start_grace_seconds,
        }
        recorder.log_decision(
            decision_id=decision_id,
            ts=now,
            scenario=self._scenario,
            phase=phase,
            judgment=judgment,
            judge_input=judge_input,
            timing=timing,
            config=config,
            fresh_observation_id=fresh_observation_id,
            history_observation_ids=history_observation_ids,
        )

    def _log_judgment(
        self,
        now: float,
        judgment: ProgressJudgment,
        image_path: str,
        user_text="",
    ) -> None:
        import os as _os

        try:
            _os.makedirs(_os.path.dirname(self._log_path) or ".", exist_ok=True)
            entry = {
                "ts": now,
                "making_progress": judgment.making_progress,
                "confidence": judgment.confidence,
                "struggle_category": judgment.struggle_category,
                "evidence": judgment.evidence,
                "should_intervene": judgment.should_intervene,
                "trigger_type": judgment.trigger_type,
                "teaching_depth": judgment.teaching_depth,
                "consecutive_struggle": self._consecutive_struggle,
                "image_path": image_path,
                "raw": judgment.raw,
                "user_text": user_text,
            }
            print(f"ProgressDetector judgment log path: {self._log_path}")
            # print(f"ProgressDetector judgment log entry: {entry}")
            with open(self._log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            logger.debug(f"ProgressDetector: failed to log judgment: {e}")
