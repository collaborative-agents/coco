import os
import time
from datetime import datetime
from pathlib import Path

from proactive_tutor.agents.diagnostic import DiagnosticAgent
from proactive_tutor.agents.tutor import TutorAgent
from proactive_tutor.ai_tool_capabilities import (
    format_tool_names,
    get_capabilities_for_tools,
)
from py_utils.logging import init_logger
from py_utils.training_recorder import TrainingRecorder

logger = init_logger(__name__)


class TutorSystem:
    """
    Two-stage tutoring pipeline: Diagnostic -> Tutor.

    Observation is generated upstream by the Streamer's ObserverAgent and
    passed in as a pre-computed string.  This class handles only diagnosis and
    guidance generation, maintains conversation history, and exposes context
    (including image_num) for the Streamer to read via GET /context.

    Exposed over HTTP by tutor_server.py.
    """

    def __init__(
        self,
        # model_name: str = "gemini/gemini-2.5-pro",
        model_name: str = "anthropic/claude-sonnet-4-20250514",
        scenario: str = "everyday_support",
    ):
        self._scenario = scenario
        prompts_dir = self._prompts_dir(scenario)
        self.diagnostic_agent = DiagnosticAgent(
            model_name, (prompts_dir / "diagnostic.txt").read_text()
        )
        self.tutor_agent = TutorAgent(
            model_name, (prompts_dir / "tutor.txt").read_text()
        )

        self.problem_statement: str = ""
        # Long-term personalized context for worker/everyday scenarios, rendered as
        # the <memory> block (replaces <problem_statement> for those scenarios).
        # User-editable and persisted to disk so it carries across sessions and
        # restarts (see _memory_path / set_memory).
        self.memory: str = self._load_memory()
        self.conversation_history: list[str] = []
        self.image_num: int = 0

        # Training-data recorder — only active when the launcher set a shared
        # records dir ($COCO_RECORDS_DIR), so tutor LLM calls land in the same
        # directory as the sensing observations/decisions for joint training.
        self._recorder: TrainingRecorder | None = (
            TrainingRecorder(os.environ["COCO_RECORDS_DIR"])
            if os.environ.get("COCO_RECORDS_DIR")
            else None
        )

        # ── AI tools context ──────────────────────────────────────────────────
        # Populated by set_ai_tools() after the session starts.
        self._ai_tools: list[str] = []
        self._ai_tools_capability_text: str = ""

        # ── AI fluency curriculum tracking ────────────────────────────────────
        # Which concepts have been introduced to this user (one-time flags).
        self.curriculum_state: dict[str, bool] = {
            "framework_introduced": False,
            "delegation_introduced": False,
            "description_introduced": False,
            "discernment_introduced": False,
            "diligence_introduced": False,
        }
        # How many times each competency has been coached this session.
        self.competency_counts: dict[str, int] = {
            "delegation": 0,
            "description": 0,
            "discernment": 0,
            "diligence": 0,
        }
        # Total number of tutor interventions this session.
        self.intervention_count: int = 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _prompts_dir(scenario: str) -> Path:
        """Return the prompts directory Path for the given scenario.

        ``"student_learning"`` → prompts_problem_solving/
        Any other value (including ``"everyday_support"``) → prompts_everyday/
        """
        dir_name = {
            "student_learning": "prompts_problem_solving",
        }.get(scenario, "prompts_everyday")
        return Path(__file__).parent / dir_name

    def _log_tutor_call(
        self,
        trigger: str,
        tutor_input: str,
        tutor_output: str,
        image_paths: list[str] | None,
    ) -> None:
        """Record the tutor LLM call (input + generated guidance) for training."""
        if self._recorder is None:
            return
        try:
            self._recorder.log_tutor(
                ts=time.time(),
                session_id=None,  # the tutor process doesn't track the Mongo session id
                trigger=trigger,
                scenario=self._scenario,
                model=getattr(self.tutor_agent, "model", ""),
                tutor_input=tutor_input,
                tutor_output=tutor_output,
                image_paths=image_paths,
            )
        except Exception as e:
            logger.debug(f"[TUTOR] failed to log tutor call: {e}")

    def _curriculum_context_block(self) -> str:
        """Build XML blocks injected into both diagnostic and tutor prompts."""
        lines = [
            "<curriculum_state>",
            f"  framework_introduced: {self.curriculum_state['framework_introduced']}",
            f"  delegation_introduced: {self.curriculum_state['delegation_introduced']}",
            f"  description_introduced: {self.curriculum_state['description_introduced']}",
            f"  discernment_introduced: {self.curriculum_state['discernment_introduced']}",
            f"  diligence_introduced: {self.curriculum_state['diligence_introduced']}",
            "</curriculum_state>",
            "<recurrence_counts>",
            f"  delegation: {self.competency_counts['delegation']}",
            f"  description: {self.competency_counts['description']}",
            f"  discernment: {self.competency_counts['discernment']}",
            f"  diligence: {self.competency_counts['diligence']}",
            "</recurrence_counts>",
        ]
        return "\n".join(lines)

    def _ai_tools_context_block(self) -> str:
        """Build an <ai_tools_context> XML block for the current session.

        Returns an empty string when no tools have been configured (e.g. the
        user skipped the onboarding step or the field wasn't forwarded yet).
        """
        if not self._ai_tools_capability_text:
            return ""
        tool_list = format_tool_names(self._ai_tools)
        return (
            "<ai_tools_context>\n"
            f"The user has access to the following AI tool(s): {tool_list}\n\n"
            f"{self._ai_tools_capability_text}\n"
            "</ai_tools_context>"
        )

    def _update_curriculum_state(
        self, trigger_type: str, weak_competency: str | None = None
    ) -> None:
        """Update curriculum_state and competency_counts after a tutor fires.

        Called after every successful intervention so subsequent judge/diagnostic
        prompts reflect the user's latest learning state.
        """
        self.intervention_count += 1

        if trigger_type == "framework_introduction":
            self.curriculum_state["framework_introduced"] = True

        elif trigger_type == "teaching_moment" and weak_competency:
            key = f"{weak_competency}_introduced"
            if key in self.curriculum_state:
                self.curriculum_state[key] = True
            if weak_competency in self.competency_counts:
                self.competency_counts[weak_competency] += 1

        elif trigger_type == "discernment_opportunity":
            self.curriculum_state["discernment_introduced"] = True
            self.competency_counts["discernment"] += 1

        elif trigger_type == "blind_acceptance":
            # Blind acceptance coaching touches Discernment.
            self.competency_counts["discernment"] += 1

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    def set_model(self, model_name: str) -> None:
        """Reconfigure both agents to use a different model."""
        logger.info(f"[SET MODEL] {model_name}")
        prompts_dir = self._prompts_dir(self._scenario)
        self.diagnostic_agent = DiagnosticAgent(
            model_name, (prompts_dir / "diagnostic.txt").read_text()
        )
        self.tutor_agent = TutorAgent(
            model_name, (prompts_dir / "tutor.txt").read_text()
        )

    def set_ai_tools(self, tool_ids: list[str]) -> None:
        """Configure which AI tools the user has access to for this session.

        Pre-computes the capability text so _ai_tools_context_block() is free
        at call time.  Call this once per session, after reset_session().
        """
        self._ai_tools = list(tool_ids)
        self._ai_tools_capability_text = get_capabilities_for_tools(tool_ids)
        logger.info(f"[AI TOOLS] Configured: {tool_ids}")

    def set_scenario(self, scenario: str) -> None:
        """Switch to a different scenario, reloading prompts for the current model."""
        logger.info(f"[SET SCENARIO] {scenario}")
        self._scenario = scenario
        prompts_dir = self._prompts_dir(scenario)
        model_name = self.diagnostic_agent.model
        self.diagnostic_agent = DiagnosticAgent(
            model_name, (prompts_dir / "diagnostic.txt").read_text()
        )
        self.tutor_agent = TutorAgent(
            model_name, (prompts_dir / "tutor.txt").read_text()
        )

    @staticmethod
    def _image_dim_note(image_paths: list[str] | None) -> str:
        """Return a text snippet with pixel dimensions for each image path.

        Injected into the text prompt so the LLM can write annotation code
        using normalized (0–1) coordinates that scale correctly.
        """
        if not image_paths:
            return ""
        try:
            from PIL import Image as _Image
        except ImportError:
            return ""
        lines = []
        for path in image_paths:
            try:
                w, h = _Image.open(path).size
                lines.append(f"  {path}: {w}×{h} px")
            except Exception:
                pass
        if not lines:
            return ""
        return "\nHotkey screenshot dimensions:\n" + "\n".join(lines)

    def reset_session(self) -> None:
        """Clear all per-session state so a new session starts fresh.

        Called by the tutor server's POST /context/reset endpoint, which is
        triggered by the sensing server whenever TutorAgentNode registers a new
        session (POST /session on the sensing server).  Without this, conversation
        history and curriculum state carry over across restarts.
        """
        logger.info("[RESET] Clearing per-session state for new session")
        self.conversation_history = []
        self.problem_statement = ""
        self.image_num = 0
        self._ai_tools = []
        self._ai_tools_capability_text = ""
        self.curriculum_state = {
            "framework_introduced": False,
            "delegation_introduced": False,
            "description_introduced": False,
            "discernment_introduced": False,
            "diligence_introduced": False,
        }
        self.competency_counts = {
            "delegation": 0,
            "description": 0,
            "discernment": 0,
            "diligence": 0,
        }
        self.intervention_count = 0

    # ------------------------------------------------------------------
    # Long-term memory (user-editable, persisted across sessions)
    # ------------------------------------------------------------------

    @staticmethod
    def _memory_path() -> Path:
        """File where the long-term memory is persisted.

        Uses the app's user-data dir (``COCO_USER_DATA_DIR``, set by the Electron
        launcher) so it survives restarts; falls back to ``~/.coco`` when the
        tutor server is run standalone.
        """
        base = os.environ.get("COCO_USER_DATA_DIR")
        root = Path(base) if base else (Path.home() / ".coco")
        return root / "coco-memory.txt"

    @classmethod
    def _load_memory(cls) -> str:
        try:
            return cls._memory_path().read_text(encoding="utf-8")
        except Exception:
            return ""

    def set_memory(self, text: str) -> None:
        """Update the long-term memory and persist it to disk."""
        self.memory = text or ""
        try:
            path = self._memory_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self.memory, encoding="utf-8")
            logger.info(f"[MEMORY] updated ({len(self.memory)} chars) → {path}")
        except Exception as e:
            logger.warning(f"[MEMORY] failed to persist: {e}")

    def handle_problem_statement(self, text: str) -> None:
        logger.info(f"[PROBLEM STATEMENT] {text}")
        # with open("debug_text_prompt.txt", "a") as f:
        #     f.write(f"\n[PROBLEM STATEMENT] {text}\n")
        #     f.write("\n\n=== End of problem statement ===\n")
        self.problem_statement = text

    # ------------------------------------------------------------------
    # Context  (fetched by Streamer via GET /context)
    # ------------------------------------------------------------------

    def get_kargs(self) -> dict:
        return {
            "conversation_history": self.conversation_history,
            "problem_statement": self.problem_statement,
            "memory": self.memory,
            "image_num": self.image_num,
            "curriculum_state": self.curriculum_state,
            "competency_counts": self.competency_counts,
            "intervention_count": self.intervention_count,
            "ai_tools": self._ai_tools,
        }

    def _build_context_prompt(self, user_text: str | None = None) -> str:
        """Build a structured XML context prompt from internal state.

        Includes the problem statement and full conversation history.
        If ``user_text`` is provided it is appended as a ``<user_input>``
        block with the current timestamp, representing the message being
        processed right now (not yet recorded in conversation_history).
        """
        conv_block = (
            "\n".join(self.conversation_history)
            if self.conversation_history
            else "(no conversation history yet)"
        )
        # Student-tutoring scenarios carry a real problem the student is solving;
        # the worker/everyday product scenarios instead carry long-term personalized
        # memory (empty until a personalization/self-evolvement layer fills it).
        if self._scenario in ("student_learning", "cs224n"):
            ctx_block = (
                f"<problem_statement>\n{self.problem_statement}\n</problem_statement>"
            )
        else:
            memory = getattr(self, "memory", "") or "(no memory yet)"
            ctx_block = f"<memory>\n{memory}\n</memory>"
        parts = [
            ctx_block,
            f"<conversation_history>\n{conv_block}\n</conversation_history>",
        ]
        ai_tools_block = self._ai_tools_context_block()
        if ai_tools_block:
            parts.append(ai_tools_block)
        if user_text:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            parts.append(f'<user_input timestamp="{ts}">{user_text}</user_input>')
        return "\n\n".join(parts) + "\n"

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def handle_user_prompt(
        self,
        obs: str,
        image_paths: list[str] | None = None,
        user_text: str | None = None,
    ) -> str:
        """
        Process a user-prompt event.

        Args:
            obs:         Observation generated by the Streamer's ObserverAgent.
            image_paths: Optional screenshot file paths (e.g. a pinned hot-key
                         capture) to embed directly in the LLM call so the
                         tutor can reason about and annotate the image.
            user_text:   The raw text the user typed, used to record the user
                         turn in conversation_history with a timestamp.

        Returns:
            Tutor guidance string.
        """
        logger.info(
            f"[USER_PROMPT] Handling user prompt event. "
            f"images={len(image_paths) if image_paths else 0}"
        )

        # Build context from internal state *before* recording the user message
        # so the current turn appears in <user_input>, not in <conversation_history>.
        # Curriculum/4D-framework state is only relevant for the ai_upskilling scenario.
        curriculum_block = (
            self._curriculum_context_block()
            if self._scenario == "ai_upskilling"
            else ""
        )
        context = self._build_context_prompt(user_text=user_text)

        # Now record the user's message in history.
        if user_text:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self.conversation_history.append(f"[{ts}] [User]: {user_text}")

        dim_note = self._image_dim_note(image_paths)
        obs_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        text_prompt = (
            context
            + f"\n\n{curriculum_block}"
            + f'\n\n<observation timestamp="{obs_ts}">\n{obs}\n</observation>'
            + dim_note
        )
        guidance = self.tutor_agent.tutor(text_prompt, image_paths=image_paths)
        logger.info(f"[TUTOR] {guidance}")
        self._log_tutor_call("user_prompt", text_prompt, guidance, image_paths)
        weak_competency = None

        # print("\n=== Tutor Response ===")
        # print(guidance)
        # print("======================\n")

        # with open("debug_text_prompt.txt", "a") as f:
        #     f.write(f"\n[GUIDANCE] {guidance}\n")
        #     f.write("\n\n=== End of response ===\n")

        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.conversation_history.append(f"[{ts}] [Tutor]: {guidance}")
        # User-prompt events don't have a structured trigger_type; treat as
        # a general coaching moment and update state if a competency was targeted.
        self._update_curriculum_state("teaching_moment", weak_competency)
        return guidance

    def handle_pause(
        self,
        obs: str,
        trigger_reason: str = "struggle",
        evidence: str = "",
        teaching_depth: str = "not_applicable",
    ) -> str:
        """
        Process a pause/idle event.

        Args:
            obs:            Observation generated by the Streamer's ObserverAgent.
            trigger_reason: Why the tutor is intervening — "struggle",
                            "inefficiency", "blind_acceptance",
                            "framework_introduction", "teaching_moment",
                            "discernment_opportunity", or "pause".
            evidence:       One-sentence summary from the judge explaining the trigger.
            teaching_depth: "introduce" | "reinforce" | "deepen" | "not_applicable"

        Returns:
            Tutor guidance string.
        """
        logger.info(
            f"[PAUSE] Handling pause event. trigger_reason={trigger_reason} "
            f"teaching_depth={teaching_depth}"
        )

        _TRIGGER_FRAMING = {
            "struggle": (
                "The user appears to be stuck and not making progress. "
                "Provide a brief, non-judgmental nudge to help them move forward."
            ),
            "inefficiency": (
                "The user is making progress but doing something the hard way. "
                "Suggest a more efficient approach without interrupting their flow."
            ),
            "delegation": (
                "The user is doing a self-contained task by hand that an AI tool or "
                "agent could take over. Offer to delegate it: name a specific tool the "
                "user has and exactly what to hand off, with a ready-to-use example. "
                "Keep it a single, non-intrusive suggestion — they stay in control."
            ),
            "blind_acceptance": (
                "The user appears to be accepting AI or tutor instructions without "
                "fully understanding them. Encourage them to reflect and ask a "
                "follow-up question before continuing."
            ),
            "pause": (
                "The user has been idle for a while. "
                "Check in gently to see if they need help."
            ),
            "framework_introduction": (
                "This is the user's first introduction to the 4D AI Fluency framework "
                "(Delegation, Description, Discernment, Diligence). Give a brief, "
                "friendly overview — not a lecture. Connect it to what they're doing right now."
            ),
            "teaching_moment": (
                "The user is making good progress. This is a proactive moment to "
                "introduce or reinforce one specific 4D competency that is naturally "
                "relevant to their current activity. Use the weak_4d_competency from "
                f"the DIAGNOSIS and teaching_depth={teaching_depth} to calibrate depth."
            ),
            "discernment_opportunity": (
                "The user just applied AI-generated output to their work. This is the "
                "best moment to briefly encourage critical evaluation of the AI output "
                "before fully committing to it. Keep it short and non-intrusive."
            ),
        }

        framing = _TRIGGER_FRAMING.get(trigger_reason, _TRIGGER_FRAMING["struggle"])
        # Curriculum/4D-framework state is only relevant for the ai_upskilling scenario.
        curriculum_block = (
            self._curriculum_context_block()
            if self._scenario == "ai_upskilling"
            else ""
        )

        intervention_context = (
            f"<intervention_context>\n"
            f"  Trigger: {trigger_reason}\n"
            f"  Evidence: {evidence}\n"
            f"  Teaching Depth: {teaching_depth}\n"
            f"  Instruction: {framing}\n"
            f"</intervention_context>"
        )

        context = self._build_context_prompt() + "\n" + intervention_context

        obs_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        text_prompt = (
            context
            + f"\n\n{curriculum_block}"
            + f'\n\n<observation timestamp="{obs_ts}">\n{obs}\n</observation>'
        )
        guidance = self.tutor_agent.tutor(text_prompt)
        logger.info(f"[PAUSE][TUTOR] {guidance}")
        self._log_tutor_call("pause", text_prompt, guidance, None)
        weak_competency = None

        print("\n=== Pause Guidance ===")
        print(guidance)
        print("======================\n")

        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.conversation_history.append(f"[{ts}] [Tutor]: {guidance}")
        self._update_curriculum_state(trigger_reason, weak_competency)
        return guidance

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_weak_competency(diag: str) -> str | None:
        """Pull weak_4d_competency from the diagnostic JSON string, if present."""
        import json
        import re

        # Try to find the first JSON object in the diagnostic output.
        match = re.search(r"\{.*\}", diag, re.DOTALL)
        if not match:
            return None
        try:
            obj = json.loads(match.group(0))
            val = str(obj.get("weak_4d_competency", "none")).strip().lower()
            return val if val and val != "none" else None
        except Exception:
            return None
