"""
AI tool capability descriptions for the tutor system prompt.

Each entry is keyed by the tool ID used in the onboarding profile
(e.g. "chatgpt", "claude", "gemini") and contains a plain-text
capability summary that is injected into every LLM call via the
<ai_tools_context> block.
"""

from __future__ import annotations

_CAPABILITIES: dict[str, str] = {
    "chatgpt": (
        "ChatGPT (OpenAI)\n"
        "- Generates text: essays, emails, summaries, translations, outlines.\n"
        "- Writes and debugs code in any language.\n"
        "- Analyzes uploaded files: PDFs, spreadsheets, images, Word docs.\n"
        "- Runs Python via Code Interpreter (Advanced Data Analysis) — produces charts,\n"
        "  processes data, exports downloadable files (CSV, PNG, etc.).\n"
        "- Generates images.\n"
        "- Reads and describes images (GPT-4o vision).\n"
        "- Browses the web in real time. Good at deep web research.\n"
        "- Canvas mode: collaborative side-by-side document or code editing.\n"
        "LIMITATION: Cannot access the user's local files unless the user updates"
        "the files themselves; not good at multi-step agentic tasks such as coding."
    ),
    "qwen": (
        "Qwen (Alibaba)\n"
        "- Generates text: writing, summaries, emails, translations, analysis.\n"
        "- Strong multilingual support, especially Chinese (very strong) and English.\n"
        "- Writes and debugs code in any language.\n"
        "- Reads and describes images (Qwen-VL vision).\n"
        "- Analyzes uploaded files: PDFs, documents, spreadsheets.\n"
        "- Web access available at chat.qwen.ai.\n"
        "LIMITATION: Cannot access the user's local files unless the user updates"
        "the files themselves; not good at multi-step agentic tasks such as coding."
    ),
    "claude": (
        "Claude (Anthropic)\n"
        "- Generates text: long-form writing, analysis, emails, summaries, editing.\n"
        "- Writes and debugs code in any language. Good at writing style.\n"
        "- Artifacts: produces rendered HTML apps, React components, SVG diagrams,\n"
        "  and Markdown documents directly in the chat UI.\n"
        "- In Claude desktop (Cowork) or Claude Code: can directly create and save\n"
        "  .docx, .pptx, and .xlsx files as real files on disk.\n"
        "- Analyzes uploaded files: PDFs, images, spreadsheets, text files.\n"
        "- Projects: persistent memory and shared files across multiple chats.\n"
        "- Web search available.\n"
        "LIMITATION: Cannot generate images. No code execution in standard chat."
    ),
    "gemini": (
        "Gemini (Google)\n"
        "- Generates text: writing, summaries, emails, code, analysis.\n"
        "- Image generation.\n"
        "- Video generation.\n"
        "- Reads and describes images and videos.\n"
        "- Real-time web search via Google Search (always up to date).\n"
        "LIMITATION: Cannot access the user's local files unless the user updates"
        "the files themselves; not good at multi-step agentic tasks such as coding."
    ),
    "grok": (
        "Grok (xAI)\n"
        "- Text generation: writing, summaries, analysis, code, conversation.\n"
        "- Image generation.\n"
        "- Reads and describes images.\n"
        "- Real-time web search with especially strong access to X (Twitter) posts and trends.\n"
        "- DeepSearch mode: in-depth multi-step research using live web data.\n"
        "- Voice mode.\n"
        "- Trained with X (Twitter) data: good at X-specific research or X-related tasks (e.g., write tweets).\n"
        "LIMITATION: Cannot access the user's local files unless the user updates"
        "the files themselves; not good at multi-step agentic tasks such as coding."
    ),
    "claude-code": (
        "Claude Code (Anthropic) — AI AGENT\n"
        "- Runs in the terminal — reads, writes, and edits files in the user's project.\n"
        "- Full codebase awareness: understands the entire repo, not just a single file.\n"
        "- Executes shell commands, runs tests, installs packages — takes autonomous multi-step actions.\n"
        "- Writes, refactors, and debugs code across multiple files at once.\n"
        "- Can open PRs, run CI checks, and complete complex engineering tasks end-to-end.\n"
        "- MCP (Model Context Protocol): connects to external tools, databases, and APIs.\n"
        "LIMITATION: Terminal-based — requires comfort with the command line.\n"
        "Slower than chatbot as the agent usually needs to run multiple actions sequentially."
    ),
    "claude-cowork": (
        "Claude Cowork (Anthropic) — AI AGENT\n"
        "- Desktop agent with access to local files and folders.\n"
        "- Creates real files: .docx, .pptx, .xlsx — saved directly to the user's computer.\n"
        "- Executes multi-step tasks: research → write → format → save.\n"
        "- Connects to external tools via MCP: Slack, Google Drive, Notion, Asana, and more.\n"
        "- Schedules recurring tasks automatically.\n"
        "- Plugin ecosystem: install domain-specific skills and connectors.\n"
        "LIMITATION: Use up context window faster compared to claude-code.\n"
        "Slower than chatbot as the agent usually needs to run multiple actions sequentially."
    ),
    "gemini-cli": (
        "Gemini CLI (Google) — AI AGENT\n"
        "- Runs in the terminal — reads and writes files, executes shell commands.\n"
        "- 1M token context window: can load an entire large codebase into context at once.\n"
        "- Integrated Google Search: can look up real-time information mid-task.\n"
        "- MCP support: connects to external tools and services.\n"
        "- Handles both coding tasks and general-purpose tasks from the terminal.\n"
        "- Free tier available via Google AI Studio.\n"
        "LIMITATION: Slower than chatbot as the agent usually needs to run multiple actions sequentially."
    ),
    "codex": (
        "Codex (OpenAI) — AI AGENT\n"
        "- Cloud-based agentic coding assistant available inside ChatGPT (Plus/Pro).\n"
        "- Works directly on GitHub repositories: reads, edits, commits, and opens PRs autonomously.\n"
        "- Runs coding tasks in a sandboxed cloud environment — no local IDE required.\n"
        "- Can run a full software task end-to-end: understand the issue, write code, run tests, fix failures.\n"
        "- Supports multiple parallel tasks asynchronously.\n"
        "- Shows diffs and explains reasoning before applying changes.\n"
        "LIMITATION: Slower than chatbot as the agent usually needs to run multiple actions sequentially."
    ),
    "opencode": (
        "OpenCode — AI AGENT\n"
        "- Open-source coding agent that runs in the terminal — reads, writes, and edits files in the user's project.\n"
        "- Model-agnostic: works with many providers (Claude, GPT, Gemini, local models); the user picks the model.\n"
        "- Full codebase awareness: understands the entire repo, not just a single file.\n"
        "- Executes shell commands, runs tests, and takes autonomous multi-step actions.\n"
        "- MCP support: connects to external tools, databases, and APIs.\n"
        "LIMITATION: Terminal-based — requires comfort with the command line.\n"
        "Slower than chatbot as the agent usually needs to run multiple actions sequentially."
    ),
}


# User-defined tools from onboarding are encoded as single strings so they ride
# through the same aiTools list (see observation-types.ts):
#   custom_chatbot:<name>|<url>|<description>
#   custom_agent:<name>|<description>
_CUSTOM_CHATBOT_PREFIX = "custom_chatbot:"
_CUSTOM_AGENT_PREFIX = "custom_agent:"


def _parse_custom_tool(tool_id: str) -> tuple[str, str, str, str] | None:
    """Parse a custom tool id into (kind, name, url, description).

    kind is "chatbot" or "agent"; url is "" for agents. Returns None when the
    id is not a custom encoding or has no name.
    """
    if tool_id.startswith(_CUSTOM_CHATBOT_PREFIX):
        parts = tool_id[len(_CUSTOM_CHATBOT_PREFIX) :].split("|")
        name = parts[0].strip() if parts else ""
        url = parts[1].strip() if len(parts) > 1 else ""
        desc = "|".join(parts[2:]).strip() if len(parts) > 2 else ""
        return ("chatbot", name, url, desc) if name else None
    if tool_id.startswith(_CUSTOM_AGENT_PREFIX):
        parts = tool_id[len(_CUSTOM_AGENT_PREFIX) :].split("|")
        name = parts[0].strip() if parts else ""
        desc = "|".join(parts[1:]).strip() if len(parts) > 1 else ""
        return ("agent", name, "", desc) if name else None
    return None


def _custom_capability_text(kind: str, name: str, url: str, desc: str) -> str:
    """Build a capability block for a user-added tool."""
    label = "AI AGENT" if kind == "agent" else "AI chatbot"
    lines = [f"{name} ({label}, user-added)"]
    if desc:
        lines.append(f"- {desc}")
    if url:
        lines.append(f"- Website: {url}")
    return "\n".join(lines)


def format_tool_names(tool_ids: list[str]) -> str:
    """Human-readable, comma-separated tool names for the <ai_tools_context>
    header. Built-in tools show their ID; custom tools show their given name
    (never the raw `custom_*:...|...` encoding)."""
    names: list[str] = []
    for tid in tool_ids:
        if tid in _CAPABILITIES:
            names.append(tid)
            continue
        custom = _parse_custom_tool(tid)
        if custom:
            names.append(custom[1])
    return ", ".join(names)


def get_capabilities_for_tools(tool_ids: list[str]) -> str:
    """Return a formatted capability summary for a list of tool IDs.

    Built-in IDs use their bundled description; user-added tools
    (``custom_chatbot:``/``custom_agent:``) use the name + description the user
    provided during onboarding. Unrecognized IDs are silently skipped. Returns
    an empty string if nothing matched (so callers can omit the block).

    Example:
        >>> get_capabilities_for_tools(["claude", "chatgpt"])
        'Claude (Anthropic)\\n- ...'
    """
    parts: list[str] = []
    for tid in tool_ids:
        if tid in _CAPABILITIES:
            parts.append(_CAPABILITIES[tid])
            continue
        custom = _parse_custom_tool(tid)
        if custom:
            parts.append(_custom_capability_text(*custom))
    return "\n\n".join(parts)
