"""
FastAPI server exposing TutorSystem over HTTP.

Run:
    uv run python -m proactive_tutor.tutor_server

Endpoints:
    GET  /health
    POST /events/user_prompt   {observation, user_text?, image_paths?} -> {guidance}
    POST /events/pause         {observation, text_prompt} -> {guidance}
    GET  /context              -> {conversation_history, problem_statement}
    POST /context/problem_statement  {problem_statement} -> {status}
    GET  /viz/{exec_id}        -> serves visualization HTML output
"""

import asyncio
import json
from pathlib import Path

import chz
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from proactive_tutor.html_executor import VIZ_ROOT, VizResult, save_html_visualization
from proactive_tutor.tutor_system import TutorSystem
from py_utils.logging import init_logger
from pydantic import BaseModel

load_dotenv()

logger = init_logger(__name__)

app = FastAPI(title="Tutor System API")
tutor: TutorSystem | None = None

# Model the server was started with. Used by the stateless /suggestion/instant
# endpoint, which does not own a TutorSystem instance. Set in main_async().
configured_model_name: str = "anthropic/claude-sonnet-4-20250514"


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class EventRequest(BaseModel):
    observation: str
    image_paths: list[str] | None = (
        None  # absolute paths of screenshots to send to the LLM
    )
    trigger_reason: str = (
        "struggle"  # "struggle" | "inefficiency" | "blind_acceptance" | "pause"
        #            | "framework_introduction" | "teaching_moment"
        #            | "discernment_opportunity"
    )
    evidence: str = (
        ""  # one-sentence summary from the judge LLM explaining why it fired
    )
    teaching_depth: str = (
        "not_applicable"  # "introduce" | "reinforce" | "deepen" | "not_applicable"
    )
    user_text: str | None = (
        None  # raw text typed by the user; recorded in conversation_history with a timestamp
    )


class GuidanceResponse(BaseModel):
    guidance: str


class InstantSuggestionRequest(BaseModel):
    observation: str
    task_label: str | None = None
    scenario: str = "everyday_support"
    ai_tools: list[str] = []


class InstantSuggestionResponse(BaseModel):
    kind: str  # "content" | "delegate"
    title: str
    body: str | None = None
    targetTool: str | None = None
    prompt: str | None = None
    copyText: str  # unified text the UI copies (body for content, prompt for delegate)


class ContextResponse(BaseModel):
    conversation_history: list[str]
    problem_statement: str
    memory: str = ""
    image_num: int
    curriculum_state: dict = {}
    competency_counts: dict = {}
    intervention_count: int = 0


class ModelRequest(BaseModel):
    model: str


class ScenarioRequest(BaseModel):
    scenario: str


class ProblemStatementRequest(BaseModel):
    problem_statement: str


class MemoryRequest(BaseModel):
    memory: str


class MemoryResponse(BaseModel):
    memory: str


class AiToolsRequest(BaseModel):
    ai_tools: list[str]


class StatusResponse(BaseModel):
    status: str


class VizRetryRequest(BaseModel):
    code: str
    error: dict  # {reason, stderr, exit_code} from VizResult
    problem_statement: str | None = None


class VizRetryResponse(BaseModel):
    visualization_url: str | None
    visualization_code: str | None
    visualization_error: dict | None
    changes_summary: str | None


# ---------------------------------------------------------------------------
# Visualization execution helper
# ---------------------------------------------------------------------------


def _repair_json_escapes(text: str) -> str:
    r"""Fix invalid JSON escape sequences commonly produced by LLMs.

    LLMs embed LaTeX (``\sqrt``, ``\alpha``, ``\cos``) inside JSON strings,
    producing invalid escapes that cause ``json.loads`` to fail.  This
    function double-escapes backslashes that are NOT followed by a valid
    JSON escape character (``" \ / b f n r t u``).

    Ambiguous cases (``\frac`` where ``\f`` = form-feed, ``\theta`` where
    ``\t`` = tab) are *not* repaired here because they don't cause parse
    failure — they produce wrong characters but the JSON is still valid.
    The tutor prompt has been updated to use ``$...$`` LaTeX notation which
    avoids the ambiguity.  This function targets the clear-cut invalid
    escapes (``\s``, ``\a``, ``\c``, ``\d``, ``\g``, ``\l``, etc.) that
    make the JSON unparseable.

    Must be called *before* ``json.loads``.
    """
    _VALID_AFTER_BACKSLASH = set('"\\\\/bfnrtu')

    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt in _VALID_AFTER_BACKSLASH:
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            else:
                # Invalid escape (e.g. \sqrt → \\sqrt)
                out.append("\\\\")
                i += 1
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _extract_json_object(text: str) -> dict | None:
    """
    Extract the first valid JSON object from *text*, even when the LLM prepends
    conversational prose before the JSON block.

    Uses brace-depth counting (respecting quoted strings and escape sequences)
    so nested objects are handled correctly. Applies escape-repair before
    ``json.loads`` so LaTeX-containing strings don't cause parse failures.
    """
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escape_next = False
        for i in range(start, len(text)):
            ch = text[i]
            if escape_next:
                escape_next = False
                continue
            if ch == "\\" and in_string:
                escape_next = True
                continue
            if ch == '"':
                in_string = not in_string
            if not in_string:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start : i + 1]
                        # Try strict parse first, then repaired.
                        try:
                            return json.loads(candidate)
                        except json.JSONDecodeError:
                            pass
                        try:
                            return json.loads(_repair_json_escapes(candidate))
                        except json.JSONDecodeError:
                            break  # try next '{' position
        start = text.find("{", start + 1)
    return None


def _process_guidance(raw_guidance: str) -> str:
    """
    Parse the LLM guidance output, save any HTML visualization to disk, and
    return a clean JSON string for the frontend.

    Supported LLM output formats (tried in order):
      1. XML-tag format (new, preferred) — <guidance>...</guidance> etc.
         Text fields can contain any characters; no JSON-escaping issues.
      2. JSON object (legacy) — bare or wrapped in ```json fences.
         HTML may be in a separate ```html fence or embedded in a field.

    Always returns a JSON string with keys:
      guidance, example_prompt, visualization, visualization_url,
      visualization_error, visualization_code
    """
    import re as _re

    raw = raw_guidance.strip()

    # ── Helpers ───────────────────────────────────────────────────────────────

    _html_fence_re = _re.compile(r"```html\s*\n(.*?)```", _re.DOTALL)
    _raw_html_re = _re.compile(
        r"(<!DOCTYPE\s+html>.*?</html>)", _re.DOTALL | _re.IGNORECASE
    )
    _xml_tag_re = lambda tag: _re.compile(  # noqa: E731
        rf"<{tag}>(.*?)</{tag}>", _re.DOTALL | _re.IGNORECASE
    )

    _html_tag_re = _re.compile(
        r"<html_code>(.*?)</html_code>", _re.DOTALL | _re.IGNORECASE
    )

    def _extract_html(text: str):
        """Return (html_str, match_start) from a <html_code> tag, ```html fence, or bare block."""
        # Preferred: explicit <html_code> XML tag (most unambiguous).
        m = _html_tag_re.search(text)
        if m:
            return m.group(1).strip(), m.start()
        # Fallback: ```html ... ``` fence.
        m = _html_fence_re.search(text)
        if m:
            return m.group(1).strip(), m.start()
        # Fallback: bare <!DOCTYPE html> ... </html> block.
        m = _raw_html_re.search(text)
        if m:
            return m.group(1).strip(), m.start()
        return "", len(text)

    # Strip any XML-tag artifacts from a text field (e.g. if the LLM placed
    # <example_prompt> or <visualization> inside the <guidance> block).
    _any_xml_tag_re = _re.compile(r"</?[a-zA-Z_][a-zA-Z0-9_]*>", _re.IGNORECASE)

    def _strip_xml_artifacts(text: str) -> str:
        return _any_xml_tag_re.sub("", text).strip()

    # ── 1. Try XML-tag format ─────────────────────────────────────────────────
    # Preferred: <guidance>...</guidance> <example_prompt>...</example_prompt>
    # <visualization>yes/no</visualization>  followed by optional ```html block.
    guidance_m = _xml_tag_re("guidance").search(raw)
    visualization_m = _xml_tag_re("visualization").search(raw)

    # When the model omits <guidance> but still uses <visualization>, recover
    # by treating all text before the first XML tag as the guidance.
    if not guidance_m and visualization_m:
        ep_m_pre = _xml_tag_re("example_prompt").search(raw)
        html_m_pre = _re.compile(r"<html_code>", _re.IGNORECASE).search(raw)
        first_tag_pos = min(
            (m.start() for m in [visualization_m, ep_m_pre, html_m_pre] if m),
            default=visualization_m.start(),
        )
        pre_tag = raw[:first_tag_pos].strip()
        if pre_tag:
            # Synthesise a virtual guidance match result via a simple wrapper.
            class _FakeMatch:
                def group(self, n):
                    return pre_tag

            guidance_m = _FakeMatch()

    if guidance_m:
        # Strip stray XML tags the LLM may have placed inside the guidance block.
        guidance_text = _strip_xml_artifacts(guidance_m.group(1))
        # Default to "no" — tutor prompt no longer asks for visualization.
        visualization = "no"
        if visualization_m:
            viz_tag_content = visualization_m.group(1).strip().lower()
            visualization = "yes" if viz_tag_content.startswith("yes") else "no"
        ep_m = _xml_tag_re("example_prompt").search(raw)
        example_prompt = ep_m.group(1).strip() if ep_m else "not applicable"

        html_code, _ = _extract_html(raw)
        if not html_code and visualization == "yes" and visualization_m:
            html_code, _ = _extract_html(visualization_m.group(1))

        logger.info("Parsed guidance in XML-tag format.")
        obj = {
            "guidance": guidance_text,
            "example_prompt": example_prompt,
            "visualization": visualization,
        }

    else:
        # ── 2. Fall back to JSON format ───────────────────────────────────────
        # Extract HTML before JSON parsing so the brace-depth counter in
        # _extract_json_object is not confused by HTML braces.
        html_code, html_start = _extract_html(raw)
        json_text = raw[:html_start].rstrip() if html_code else raw

        # Strip optional ```json ... ``` wrapper.
        if json_text.startswith("```"):
            lines = json_text.splitlines()
            inner = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
            json_text = "\n".join(inner).strip()

        obj = _extract_json_object(json_text)

        if obj is None or not isinstance(obj, dict):
            return raw_guidance

        has_guidance = "Text guidance" in obj or "guidance" in obj
        if not has_guidance:
            return raw_guidance

        visualization = (
            str(obj.get("Visualization", obj.get("visualization", "no")))
            .lower()
            .strip()
        )

        # Legacy: HTML may be embedded in a JSON field rather than a fence.
        if not html_code:
            html_code = str(
                obj.get("html_visualization_code", "")
                or obj.get("python visualization code", "")
                or obj.get("python_visualization_code", "")
            ).strip()

        # Normalise guidance key.
        guidance_key = "guidance" if "guidance" in obj else "Text guidance"
        guidance_text = str(obj.get(guidance_key, ""))
        example_prompt = str(obj.get("example_prompt", "not applicable"))

        # Strip any stray ```html fence from inside the guidance text.
        gf = _html_fence_re.search(guidance_text)
        if gf:
            if not html_code:
                html_code = gf.group(1).strip()
                visualization = "yes"
                logger.info(
                    "Extracted HTML from inside guidance text (LLM misplaced it)."
                )
            obj[guidance_key] = (
                guidance_text[: gf.start()].rstrip()
                + guidance_text[gf.end() :].lstrip()
            )
            guidance_text = obj[guidance_key]

        obj = {
            "guidance": guidance_text,
            "example_prompt": example_prompt,
            "visualization": visualization,
        }

        logger.info("Parsed guidance in JSON format (legacy).")

    # ── 3. Save HTML to disk ──────────────────────────────────────────────────
    if visualization == "yes" and html_code:
        logger.info("Saving HTML visualization...")
        viz_result: VizResult = save_html_visualization(html_code)
        if viz_result.exec_id and viz_result.reason == "ok":
            obj["visualization_url"] = f"/api/tutor/viz/{viz_result.exec_id}"
            obj["visualization_error"] = None
            logger.info("Visualization ready: /api/tutor/viz/%s", viz_result.exec_id)
        else:
            logger.warning(
                "HTML visualization save failed (reason=%s).", viz_result.reason
            )
            obj["visualization_url"] = None
            obj["visualization_error"] = {
                "reason": viz_result.reason,
                "stderr": viz_result.stderr,
                "exit_code": viz_result.exit_code,
            }
    else:
        obj["visualization_url"] = None
        obj["visualization_error"] = None

    # ── 4. Expose code for the retry button ───────────────────────────────────
    obj["visualization_code"] = html_code if html_code else None

    return json.dumps(obj)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health", response_model=StatusResponse)
async def health():
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    return StatusResponse(status="healthy")


@app.post("/suggestion/instant", response_model=InstantSuggestionResponse)
async def suggestion_instant(req: InstantSuggestionRequest):
    """Generate a ready-to-use suggestion for a single observation.

    Stateless and pre-session: does NOT require an initialized TutorSystem.
    The desktop app calls this eagerly when a proactive bubble appears so the
    suggestion can be revealed instantly when the user clicks "Help me".
    """
    from proactive_tutor.instant_suggestion import generate_instant_suggestion

    try:
        result = await asyncio.to_thread(
            generate_instant_suggestion,
            req.observation,
            req.task_label,
            req.scenario,
            req.ai_tools,
            configured_model_name,
        )
        return InstantSuggestionResponse(**result)
    except Exception as e:
        logger.error(f"instant suggestion failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/events/user_prompt", response_model=GuidanceResponse)
async def handle_user_prompt(req: EventRequest):
    """Receive a pre-computed observation + context and return tutor guidance."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    try:
        # TutorSystem calls are blocking (LLM I/O); run in a thread.
        raw_guidance = await asyncio.to_thread(
            tutor.handle_user_prompt,
            req.observation,
            req.image_paths,
            req.user_text,
        )
        # Execute visualization code (also blocking) and mutate the JSON.
        guidance = await asyncio.to_thread(_process_guidance, raw_guidance)
        return GuidanceResponse(guidance=guidance)
    except Exception as e:
        logger.error(f"Error in handle_user_prompt: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/events/pause", response_model=GuidanceResponse)
async def handle_pause(req: EventRequest):
    """Receive a pre-computed observation + context for a pause event and return tutor guidance."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    try:
        raw_guidance = await asyncio.to_thread(
            tutor.handle_pause,
            req.observation,
            req.trigger_reason,
            req.evidence,
            req.teaching_depth,
        )
        guidance = await asyncio.to_thread(_process_guidance, raw_guidance)
        return GuidanceResponse(guidance=guidance)
    except Exception as e:
        logger.error(f"Error in handle_pause: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/context", response_model=ContextResponse)
async def get_context():
    """Return conversation history and problem statement for the Streamer to build context prompts."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    kargs = tutor.get_kargs()
    return ContextResponse(
        conversation_history=kargs["conversation_history"],
        problem_statement=kargs["problem_statement"],
        memory=kargs.get("memory", ""),
        image_num=kargs["image_num"],
        curriculum_state=kargs.get("curriculum_state", {}),
        competency_counts=kargs.get("competency_counts", {}),
        intervention_count=kargs.get("intervention_count", 0),
    )


@app.post("/config/model", response_model=StatusResponse)
async def set_model(req: ModelRequest):
    """Switch the model used by both diagnostic and tutor agents."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.set_model(req.model)
    logger.info(f"Model updated: {req.model}")
    return StatusResponse(status="ok")


@app.post("/config/scenario", response_model=StatusResponse)
async def set_scenario(req: ScenarioRequest):
    """Switch the scenario (student_learning, ai_upskilling, or everyday_support), reloading prompts."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.set_scenario(req.scenario)
    logger.info(f"Scenario updated: {req.scenario}")
    return StatusResponse(status="ok")


@app.post("/context/problem_statement", response_model=StatusResponse)
async def set_problem_statement(req: ProblemStatementRequest):
    """Set the problem statement on the TutorSystem."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.handle_problem_statement(req.problem_statement)
    logger.info(f"Problem statement updated: {req.problem_statement[:80]}...")
    return StatusResponse(status="ok")


@app.get("/context/memory", response_model=MemoryResponse)
async def get_memory():
    """Return the long-term personalized memory (for the UI to view/edit)."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    return MemoryResponse(memory=tutor.memory)


@app.post("/context/memory", response_model=StatusResponse)
async def set_memory(req: MemoryRequest):
    """Replace the long-term personalized memory and persist it to disk."""
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.set_memory(req.memory)
    return StatusResponse(status="ok")


@app.post("/context/ai_tools", response_model=StatusResponse)
async def set_ai_tools(req: AiToolsRequest):
    """Set which AI tools the user has access to for this session.

    Should be called once per session, after POST /context/reset, so the
    <ai_tools_context> block is injected into every subsequent LLM call.
    """
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.set_ai_tools(req.ai_tools)
    logger.info(f"AI tools configured: {req.ai_tools}")
    return StatusResponse(status="ok")


@app.post("/context/reset", response_model=StatusResponse)
async def reset_context():
    """Reset all per-session state (conversation history, curriculum state, problem statement).

    Called by the sensing server whenever a new TutorAgentNode session begins so
    that conversation history and curriculum progress from the previous session do
    not bleed into the new one.
    """
    if tutor is None:
        raise HTTPException(status_code=503, detail="TutorSystem not initialized")
    tutor.reset_session()
    logger.info("Session reset: conversation history and curriculum state cleared")
    return StatusResponse(status="ok")


@app.get("/viz/{exec_id}")
async def serve_visualization(exec_id: str):
    """Serve the HTML output for a previously executed visualization."""
    # Sanitise exec_id to prevent path traversal (UUIDs only).
    import re

    if not re.fullmatch(r"[0-9a-f\-]{36}", exec_id):
        raise HTTPException(status_code=400, detail="Invalid exec_id format")

    html_path = VIZ_ROOT / exec_id / "output.html"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Visualization not found")

    return FileResponse(str(html_path), media_type="text/html")


# ---------------------------------------------------------------------------
# Visualization retry (code-fixer agent)
# ---------------------------------------------------------------------------

_VIZ_FIXER_PROMPT_PATH = Path(__file__).parent / "prompts_everyday" / "viz_fixer.txt"
_VIZ_FIXER_PROMPT: str | None = None

_MAX_RETRIES_PER_REQUEST = 2


def _get_viz_fixer_prompt() -> str:
    global _VIZ_FIXER_PROMPT
    if _VIZ_FIXER_PROMPT is None:
        _VIZ_FIXER_PROMPT = _VIZ_FIXER_PROMPT_PATH.read_text(encoding="utf-8")
    return _VIZ_FIXER_PROMPT


def _run_viz_fixer(code: str, error: dict, problem_statement: str | None) -> dict:
    """Call the fixer LLM and return parsed {fixed_code, changes_summary}."""
    from external_api.llm import prompt_to_text

    user_prompt_lines = [
        "ORIGINAL CODE:",
        code,
        "",
        f"FAILURE REASON: {error.get('reason', 'unknown')}",
    ]
    stderr = error.get("stderr")
    if stderr:
        user_prompt_lines += ["", "STDERR / TRACEBACK:", stderr]
    exit_code = error.get("exit_code")
    if exit_code is not None:
        user_prompt_lines.append(f"\nEXIT CODE: {exit_code}")
    if problem_statement:
        user_prompt_lines += ["", "PROBLEM STATEMENT:", problem_statement]
    user_prompt_lines += [
        "",
        "Now produce your JSON with fixed_code and changes_summary.",
    ]

    model = tutor.tutor_agent.model if tutor else "gemini/gemini-2.5-flash"
    raw = prompt_to_text(
        model=model,
        system_prompt=_get_viz_fixer_prompt(),
        user_prompt="\n".join(user_prompt_lines),
    )
    obj = _extract_json_object(raw)
    if not obj or "fixed_code" not in obj:
        raise ValueError(f"Fixer LLM did not return valid JSON: {raw[:300]}")
    return obj


@app.post("/viz/retry", response_model=VizRetryResponse)
async def retry_visualization(req: VizRetryRequest):
    """Ask the code-fixer agent to fix a failed visualization and re-execute."""
    try:
        fixer_result = await asyncio.to_thread(
            _run_viz_fixer, req.code, req.error, req.problem_statement
        )
    except Exception as e:
        logger.error(f"Viz fixer LLM failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Fixer agent error: {e}") from e

    fixed_code = fixer_result["fixed_code"]
    changes_summary = fixer_result.get("changes_summary", "")

    viz_result: VizResult = await asyncio.to_thread(save_html_visualization, fixed_code)

    if viz_result.exec_id and viz_result.reason == "ok":
        return VizRetryResponse(
            visualization_url=f"/api/tutor/viz/{viz_result.exec_id}",
            visualization_code=fixed_code,
            visualization_error=None,
            changes_summary=changes_summary,
        )
    else:
        return VizRetryResponse(
            visualization_url=None,
            visualization_code=fixed_code,
            visualization_error={
                "reason": viz_result.reason,
                "stderr": viz_result.stderr,
                "exit_code": viz_result.exit_code,
            },
            changes_summary=changes_summary,
        )


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------


async def main_async(port: int = 8081, model_name: str = "gemini/gemini-2.5-pro"):
    global tutor, configured_model_name
    configured_model_name = model_name
    # Ensure the visualization output directory exists at startup.
    VIZ_ROOT.mkdir(parents=True, exist_ok=True)
    logger.info(f"Visualization output directory: {VIZ_ROOT}")

    logger.info(f"Initializing TutorSystem with model {model_name}...")
    tutor = TutorSystem(model_name=model_name)
    logger.info(f"TutorSystem ready. Starting HTTP server on port {port}...")
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


def main(port: int = 8081, model_name: str = "gemini/gemini-2.5-pro"):
    # An empty --model_name (e.g. the desktop app leaving the choice unset)
    # falls back to this built-in default rather than an invalid empty model.
    if not (model_name or "").strip():
        model_name = "gemini/gemini-2.5-pro"
    asyncio.run(main_async(port=port, model_name=model_name))


if __name__ == "__main__":
    chz.entrypoint(main, allow_hyphens=True)
