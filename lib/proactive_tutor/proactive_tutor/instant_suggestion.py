"""
Stateless instant-suggestion generator.

Given a single observation (plus optional task label and the user's AI tools),
produce a ready-to-use suggestion that the desktop UI can reveal immediately
when the user clicks "Help me with this".

Two kinds of suggestion are produced (decided by the LLM):
  - ``content``  : a finished artifact (email, Slack message, …) to copy.
  - ``delegate`` : a ready-to-paste prompt plus the target tool to hand it to.
"""

from __future__ import annotations

import re
from pathlib import Path

from external_api.llm import prompt_to_text_with_metrics
from external_api.types import LLMCallMetrics
from proactive_tutor.ai_tool_capabilities import (
    format_tool_names,
    get_capabilities_for_tools,
)

_PROMPT_PATH = Path(__file__).parent / "prompts_everyday" / "instant_suggestion.txt"
INSTANT_SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")

_VALID_KINDS = {"content", "delegate"}

# Matches <tag>...</tag>, dot-all and case-insensitive — mirrors the parsing
# convention used for guidance output in tutor_server._process_guidance.
_any_xml_tag_re = re.compile(r"</?[a-zA-Z_][a-zA-Z0-9_]*>", re.IGNORECASE)


def _xml_tag(tag: str, text: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else None


def _strip_xml_artifacts(text: str) -> str:
    return _any_xml_tag_re.sub("", text).strip()


def _ai_tools_context_block(ai_tools: list[str]) -> str:
    """Build an <ai_tools_context> block, or "" when no tools are configured.

    Mirrors TutorSystem._ai_tools_context_block so the prompt sees the same
    format whether the suggestion is generated pre-session or in-session.
    """
    if not ai_tools:
        return ""
    capability_text = get_capabilities_for_tools(ai_tools)
    if not capability_text:
        return ""
    tool_list = format_tool_names(ai_tools)
    return (
        "<ai_tools_context>\n"
        f"The user has access to the following AI tool(s): {tool_list}\n\n"
        f"{capability_text}\n"
        "</ai_tools_context>"
    )


def _build_user_prompt(
    observation: str,
    task_label: str | None,
    ai_tools: list[str],
    memory: str = "",
    has_screenshots: bool = False,
) -> str:
    parts: list[str] = []
    if task_label:
        parts.append(f"<task_label>\n{task_label}\n</task_label>")
    parts.append(f"<observation>\n{observation}\n</observation>")
    if memory:
        parts.append(f"<memory>\n{memory}\n</memory>")
    if has_screenshots:
        parts.append(
            "<screenshots>\n"
            "Screenshot image(s) of the user's current screen are attached to "
            "this message. Use them as the primary visual context.\n"
            "</screenshots>"
        )
    tools_block = _ai_tools_context_block(ai_tools)
    if tools_block:
        parts.append(tools_block)
    return "\n\n".join(parts)


def _parse_instant_suggestion(raw: str) -> dict:
    """Parse the LLM output into a normalized suggestion dict.

    Primary path is the XML-tag format described in the system prompt. Falls
    back to a JSON object if the model returned one instead. Raises ValueError
    when nothing usable can be parsed so the caller can fall back to the
    existing chat flow.
    """
    raw = (raw or "").strip()

    kind = _xml_tag("kind", raw)
    title = _xml_tag("title", raw)
    body = _xml_tag("body", raw)
    target_tool = _xml_tag("targetTool", raw)
    prompt = _xml_tag("prompt", raw)

    # Fallback: model returned a JSON object instead of XML tags.
    if kind is None and body is None and prompt is None:
        # Imported lazily to avoid a circular import at module load time.
        from proactive_tutor.tutor_server import _extract_json_object

        obj = _extract_json_object(raw)
        if obj:
            kind = obj.get("kind") or kind
            title = obj.get("title") or title
            body = obj.get("body") or body
            target_tool = obj.get("targetTool") or obj.get("target_tool") or target_tool
            prompt = obj.get("prompt") or prompt

    kind = (kind or "").strip().lower()
    if kind not in _VALID_KINDS:
        # Infer from which payload field is present; default to content.
        kind = "delegate" if (prompt and not body) else "content"

    title = _strip_xml_artifacts(title or "Suggestion")
    body = _strip_xml_artifacts(body) if body else None
    prompt = _strip_xml_artifacts(prompt) if prompt else None
    target_tool = _strip_xml_artifacts(target_tool).lower() if target_tool else None

    if kind == "delegate":
        if not prompt:
            raise ValueError("delegate suggestion missing <prompt>")
        if not target_tool:
            target_tool = "chatgpt"
        copy_text = prompt
    else:  # content
        if not body:
            raise ValueError("content suggestion missing <body>")
        copy_text = body

    return {
        "kind": kind,
        "title": title,
        "body": body,
        "targetTool": target_tool,
        "prompt": prompt,
        "copyText": copy_text,
    }


def generate_instant_suggestion(
    observation: str,
    task_label: str | None,
    scenario: str,
    ai_tools: list[str],
    model: str,
    memory: str = "",
    image_paths: list[str] | None = None,
) -> dict:
    suggestion, _ = generate_instant_suggestion_with_metrics(
        observation, task_label, scenario, ai_tools, model, memory, image_paths
    )
    return suggestion


def generate_instant_suggestion_with_metrics(
    observation: str,
    task_label: str | None,
    scenario: str,
    ai_tools: list[str],
    model: str,
    memory: str = "",
    image_paths: list[str] | None = None,
) -> tuple[dict, LLMCallMetrics]:
    """Generate a single ready-to-use suggestion for *observation*.

    Blocking (performs LLM I/O); call from a thread in async contexts.

    ``scenario`` is accepted for parity with the observation event and future
    scenario-specific prompts; the current prompt is scenario-agnostic.
    """
    user_prompt = _build_user_prompt(
        observation,
        task_label,
        ai_tools or [],
        memory=memory,
        has_screenshots=bool(image_paths),
    )
    raw, metrics = prompt_to_text_with_metrics(
        model,
        INSTANT_SYSTEM_PROMPT,
        user_prompt,
        image_paths=image_paths,
        operation="instant_suggestion",
    )
    return _parse_instant_suggestion(raw), metrics
