"""Append-only training-data recorder for the proactive-tutor pipeline.

Lives in ``py_utils`` so that both the ``sensing`` process (observer + judge)
and the ``proactive_tutor`` process (tutor LLM) can write into the **same**
per-run directory. The shared directory is selected via the ``COCO_RECORDS_DIR``
environment variable (see ``default_records_dir``), so the two servers — even
though they run as separate processes — produce one joinable dataset.

Append-only JSONL streams, all joinable on ``session_id`` + ids + ``ts``:

- ``observations.jsonl`` — one row per OBSERVER call: full text input, screenshot
  paths (optionally copied so they survive cleanup), and JSON output. Keyed by
  ``observation_id``. *(sensing)*
- ``decisions.jsonl``    — one row per JUDGE tick: full judge input/output, timing
  + firing-policy context, and the ``observation_id``s it reasoned over.
  *(sensing, judge mode only)*
- ``episodes.jsonl``     — one row per fired nudge, referencing its ``decision_id``.
  *(sensing, judge mode only)*
- ``tutor_calls.jsonl``  — one row per TUTOR LLM call: full prompt + generated
  guidance (the delivered-assistance content). *(proactive_tutor)*
- ``feedback.jsonl``     — one row per explicit user reaction (engage / dismiss /
  thumbs up / down) to a bubble or a chat message. *(routed via sensing)*

All writes are best-effort: any failure is swallowed so data collection can
never break the live pipeline. Screenshot retention is gated behind the
``COLLECT_TRAINING_SCREENSHOTS`` env var because it is privacy-sensitive and
disk-heavy — only the observer needs the pixels; the judge/timing work is
purely textual.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path

from py_utils.logging import init_logger

logger = init_logger(__name__)


def _screenshots_enabled() -> bool:
    return os.getenv("COLLECT_TRAINING_SCREENSHOTS", "").lower() in ("1", "true", "yes")


def default_records_dir(fallback: str | None = None) -> str:
    """Return the shared records directory for this run.

    Prefers ``$COCO_RECORDS_DIR`` (set by the launcher for every server so they
    all write to one dir). Falls back to ``fallback`` if given, else a default
    under ``~/Downloads``.
    """
    env = os.environ.get("COCO_RECORDS_DIR")
    if env:
        return os.path.expanduser(env)
    if fallback:
        return os.path.expanduser(fallback)
    return os.path.expanduser("~/Downloads/coco-records")


class TrainingRecorder:
    """Best-effort writer for observation / decision / episode training rows."""

    def __init__(self, out_dir: str, retain_screenshots: bool | None = None) -> None:
        self._dir = Path(os.path.expanduser(out_dir))
        self._obs_path = self._dir / "observations.jsonl"
        self._dec_path = self._dir / "decisions.jsonl"
        self._epi_path = self._dir / "episodes.jsonl"
        self._shot_dir = self._dir / "observer_screenshots"
        self._retain = (
            _screenshots_enabled() if retain_screenshots is None else retain_screenshots
        )
        self._session_id: str | None = None
        self._lock = threading.Lock()
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.warning(f"TrainingRecorder: could not create {self._dir}: {e}")
        logger.info(
            f"TrainingRecorder writing to {self._dir} "
            f"(retain_screenshots={self._retain})"
        )

    # ------------------------------------------------------------------
    # Session
    # ------------------------------------------------------------------

    def set_session(self, session_id: str, **meta) -> None:
        """Bind subsequent rows to ``session_id`` and write/merge a manifest."""
        self._session_id = session_id
        try:
            manifest_path = self._dir / "manifest.json"
            existing: dict = {}
            if manifest_path.exists():
                existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            sessions = existing.get("sessions", {})
            sessions[session_id] = {**sessions.get(session_id, {}), **meta}
            existing["sessions"] = sessions
            manifest_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        except Exception as e:
            logger.debug(f"TrainingRecorder: manifest write failed: {e}")

    # ------------------------------------------------------------------
    # Rows
    # ------------------------------------------------------------------

    def log_observation(
        self,
        *,
        observation_id: str,
        ts: float,
        obs_type: str,
        observer_input: str,
        observer_output: str,
        model: str,
        screenshot_paths: list[str],
        llm_metrics: dict | None = None,
    ) -> None:
        retained: list[str] = []
        if self._retain and screenshot_paths:
            retained = self._copy_screenshots(observation_id, screenshot_paths)
        row = {
            "observation_id": observation_id,
            "session_id": self._session_id,
            "ts": ts,
            "type": obs_type,
            "model": model,
            "observer_input": observer_input,
            "observer_output": observer_output,
            "screenshot_paths": list(screenshot_paths),
            "retained_screenshots": retained,
        }
        if llm_metrics is not None:
            row["llm_metrics"] = llm_metrics
        self._append(self._obs_path, row)

    def log_decision(
        self,
        *,
        decision_id: str,
        ts: float,
        scenario: str,
        judgment,
        judge_input: str,
        timing: dict,
        config: dict,
        fresh_observation_id: str | None,
        history_observation_ids: list[str],
        phase: str = "nudge",
    ) -> None:
        row = {
            "decision_id": decision_id,
            "session_id": self._session_id,
            "ts": ts,
            "scenario": scenario,
            "phase": phase,
            "judge_input": judge_input,
            "judge_raw": getattr(judgment, "raw", ""),
            "making_progress": getattr(judgment, "making_progress", None),
            "confidence": getattr(judgment, "confidence", None),
            "struggle_category": getattr(judgment, "struggle_category", None),
            "evidence": getattr(judgment, "evidence", ""),
            "should_intervene": getattr(judgment, "should_intervene", None),
            "trigger_type": getattr(judgment, "trigger_type", None),
            "teaching_depth": getattr(judgment, "teaching_depth", None),
            "timing": timing,
            "config": config,
            "observer": {
                "fresh_observation_id": fresh_observation_id,
                "history_observation_ids": list(history_observation_ids),
            },
        }
        self._append(self._dec_path, row)

    def log_episode(
        self,
        *,
        decision_id: str,
        ts: float,
        trigger_reason: str,
        evidence: str,
        struggle_category: str,
        observation: str,
        phase: str = "nudge",
    ) -> None:
        row = {
            "decision_id": decision_id,
            "session_id": self._session_id,
            "ts": ts,
            "phase": phase,
            "trigger_reason": trigger_reason,
            "evidence": evidence,
            "struggle_category": struggle_category,
            "observation": observation,
            # tutor_guidance + user reaction are joined in downstream.
        }
        self._append(self._epi_path, row)

    def log_tutor(
        self,
        *,
        ts: float,
        session_id: str | None,
        trigger: str,
        scenario: str,
        model: str,
        tutor_input: str,
        tutor_output: str,
        image_paths: list[str] | None = None,
        llm_metrics: dict | None = None,
    ) -> None:
        """Log one tutor LLM call (the delivered-assistance content).

        Written by the proactive_tutor process. ``session_id`` is passed
        explicitly because that process tracks the active session itself.
        """
        row = {
            "session_id": session_id,
            "ts": ts,
            "trigger": trigger,  # "user_prompt" | "pause"
            "scenario": scenario,
            "model": model,
            "tutor_input": tutor_input,
            "tutor_output": tutor_output,
            "image_paths": list(image_paths or []),
        }
        if llm_metrics is not None:
            row["llm_metrics"] = llm_metrics
        self._append(self._dir / "tutor_calls.jsonl", row)

    def log_feedback(
        self,
        *,
        ts: float,
        session_id: str | None,
        kind: str,
        surface: str,
        observation_id: str | None = None,
        message_id: str | None = None,
        status: str | None = None,
        latency_s: float | None = None,
        text: str | None = None,
        extra: dict | None = None,
    ) -> None:
        """Log one suggestion-interaction signal.

        ``kind``: ``shown`` (an actionable suggestion was displayed) | ``engage``
        (accepted a suggestion) | ``dismiss`` (declined a suggestion) |
        ``need_help`` (asked for help on a calm/``progress`` bubble where nothing
        was suggested — a false-negative signal) | ``thumbs_up`` | ``thumbs_down``.
        ``surface``: ``bubble`` | ``chat``. An "ignore" is a ``shown`` row with no
        matching ``engage``/``dismiss`` and is derived offline.
        """
        row = {
            "ts": ts,
            "session_id": session_id,
            "kind": kind,
            "surface": surface,
            "observation_id": observation_id,
            "message_id": message_id,
            "status": status,
            "latency_s": latency_s,
            "text": text,
        }
        if extra:
            row["extra"] = extra
        self._append(self._dir / "feedback.jsonl", row)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _copy_screenshots(self, observation_id: str, paths: list[str]) -> list[str]:
        out: list[str] = []
        try:
            self._shot_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return out
        for i, src in enumerate(paths):
            try:
                if not os.path.isfile(src):
                    continue
                suffix = Path(src).suffix or ".png"
                dst = self._shot_dir / f"{observation_id}_{i}{suffix}"
                shutil.copy2(src, dst)
                out.append(str(dst))
            except OSError as e:
                logger.debug(f"TrainingRecorder: screenshot copy failed for {src}: {e}")
        return out

    def _append(self, path: Path, row: dict) -> None:
        try:
            line = json.dumps(row, default=str)
            with self._lock:
                with open(path, "a") as f:
                    f.write(line + "\n")
        except Exception as e:
            logger.debug(f"TrainingRecorder: append to {path.name} failed: {e}")
