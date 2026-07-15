/**
 * Shared types + phrase pools for the avatar status feed.
 *
 * Lives in its own module so App (state machine), PetSprite (animation
 * frames), and ObservationBubble (presentational) all stay in sync without
 * import cycles.
 */

export type ObservationStatus =
  | 'progress'
  | 'stuck'
  | 'mistake'
  | 'inefficient'
  | 'ai_struggle'
  | 'observing'
  | 'discernment_opportunity';

export interface LLMCallMetrics {
  call_id?: string;
  operation?: string | null;
  model?: string;
  provider?: string;
  modality?: 'llm' | 'vlm';
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  started_at?: number;
  ended_at?: number;
  success?: boolean;
  error?: string | null;
}

export interface ObservationEvent {
  type: string;
  observation?: string;
  status?: ObservationStatus;
  ts?: number;
  scenario?: string;
  applying_ai_output?: string;
  /** Stable id of the observer call that produced this event (for feedback joins). */
  observation_id?: string;
  llm_metrics?: LLMCallMetrics;
}

/**
 * A pre-computed, ready-to-use suggestion revealed instantly when the user
 * clicks "Help me with this". Mirrors the InstantSuggestion type in main.ts and
 * the /suggestion/instant response from the tutor server.
 *
 *  - `content`  → `body` is a finished artifact (email, message) to copy.
 *  - `delegate` → `prompt` is handed to `targetTool` (e.g. ChatGPT) on approve.
 *
 * `copyText` is the single field the Copy/Approve buttons place on the clipboard.
 */
export interface InstantSuggestion {
  kind: 'content' | 'delegate';
  title: string;
  body?: string;
  targetTool?: string;
  prompt?: string;
  copyText: string;
  llm_metrics?: LLMCallMetrics;
  /**
   * The user's own AI tools (from their onboarding selection), so a `delegate`
   * bubble can show one "Open" button per available tool and let the user pick
   * which chatbot/agent to hand the prompt to. Populated by the main process.
   */
  availableTools?: AiToolButton[];
}

// ── AI tool catalog (chatbot vs agent) ───────────────────────────────────────
// The two categories the app reasons about. A chatbot opens a website; an agent
// opens either a desktop app or a terminal window (the user pastes the copied
// prompt themselves — we never auto-run anything).

export type AiToolCategory = 'chatbot' | 'agent';

export type AiToolOpen =
  | { via: 'website'; url: string }
  | { via: 'app'; app: string } // macOS app name for `open -a`
  | { via: 'terminal' }; // open a Terminal window; user pastes the CLI prompt

export interface AiToolDef {
  id: string;
  label: string;
  category: AiToolCategory;
  open: AiToolOpen;
}

/** Trimmed shape sent to the renderer for rendering the Open buttons. */
export interface AiToolButton {
  id: string;
  label: string;
  category: AiToolCategory;
}

// Static table keyed by the tool IDs used in onboarding (AI_CHATBOTS / AI_AGENTS)
// and the capability catalog. Adding a tool is a one-line change here.
export const AI_TOOLS: Record<string, AiToolDef> = {
  // Chatbots → open their website
  chatgpt: { id: 'chatgpt', label: 'ChatGPT', category: 'chatbot', open: { via: 'website', url: 'https://chatgpt.com/' } },
  claude: { id: 'claude', label: 'Claude', category: 'chatbot', open: { via: 'website', url: 'https://claude.ai/new' } },
  gemini: { id: 'gemini', label: 'Gemini', category: 'chatbot', open: { via: 'website', url: 'https://gemini.google.com/app' } },
  grok: { id: 'grok', label: 'Grok', category: 'chatbot', open: { via: 'website', url: 'https://grok.com/' } },
  qwen: { id: 'qwen', label: 'Qwen', category: 'chatbot', open: { via: 'website', url: 'https://chat.qwen.ai/' } },
  // Agents → open a terminal (CLI) or a desktop app
  'claude-code': { id: 'claude-code', label: 'Claude Code', category: 'agent', open: { via: 'terminal' } },
  'gemini-cli': { id: 'gemini-cli', label: 'Gemini CLI', category: 'agent', open: { via: 'terminal' } },
  codex: { id: 'codex', label: 'Codex', category: 'agent', open: { via: 'terminal' } },
  opencode: { id: 'opencode', label: 'OpenCode', category: 'agent', open: { via: 'terminal' } },
  'claude-cowork': { id: 'claude-cowork', label: 'Claude Cowork', category: 'agent', open: { via: 'app', app: 'Claude' } },
};

// Encodings for user-defined tools from onboarding. Kept as single strings so
// they ride through the existing `aiTools: string[]` pipeline (profile → tutor
// context → suggestion buttons) untouched. The trailing description gives the
// tutor context about what the tool does (see ai_tool_capabilities.py).
//   chatbot: `custom_chatbot:<name>|<url>|<description>`
//   agent:   `custom_agent:<name>|<description>`
export const CUSTOM_CHATBOT_PREFIX = 'custom_chatbot:';
export const CUSTOM_AGENT_PREFIX = 'custom_agent:';

export function encodeCustomChatbot(name: string, url: string, description = ''): string {
  return `${CUSTOM_CHATBOT_PREFIX}${name.trim()}|${url.trim()}|${description.trim()}`;
}

export function encodeCustomAgent(name: string, description = ''): string {
  return `${CUSTOM_AGENT_PREFIX}${name.trim()}|${description.trim()}`;
}

/**
 * Resolve a single tool ID to a launchable definition. Handles the static
 * catalog and the `custom_chatbot:<name>|<url>|<description>` encoding. Returns
 * null for unlaunchable entries (custom agents open no URL, so they carry no
 * launch target — they still reach the tutor as context via the backend).
 */
export function parseAiTool(id: string): AiToolDef | null {
  if (AI_TOOLS[id]) return AI_TOOLS[id];
  if (id.startsWith(CUSTOM_CHATBOT_PREFIX)) {
    const parts = id.slice(CUSTOM_CHATBOT_PREFIX.length).split('|');
    const name = (parts[0] ?? '').trim();
    const url = (parts[1] ?? '').trim();
    if (!name || !url) return null;
    return { id, label: name, category: 'chatbot', open: { via: 'website', url } };
  }
  return null;
}

/**
 * Resolve the user's selected tool IDs to tool definitions, dropping
 * unknown/unlaunchable entries and ordering chatbots before agents. If
 * `preferredId` is a known tool it is moved to the front (the model's pick).
 */
export function resolveAiTools(ids: string[], preferredId?: string | null): AiToolDef[] {
  const known = ids
    .map((id) => parseAiTool(id))
    .filter((t): t is AiToolDef => Boolean(t));
  known.sort((a, b) => {
    if (a.category !== b.category) return a.category === 'chatbot' ? -1 : 1;
    return 0;
  });
  if (preferredId && parseAiTool(preferredId)) {
    known.sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : 0));
  }
  return known;
}

export type PetMood =
  | 'dormant' // pre-session: no observations received yet — static sleep1.png
  | 'idle'
  | 'write'
  | 'wait'
  | 'tool'
  | 'sleep';

// Map observation status → which animation pack the pet plays.
export const STATUS_TO_MOOD: Record<ObservationStatus, PetMood> = {
  progress: 'write',               // user is producing — pet writes along with them
  stuck: 'wait',                   // mirror the user's pause
  mistake: 'wait',                 // gentle "let's slow down and check"
  inefficient: 'tool',             // AI-could-help theme
  ai_struggle: 'tool',             // AI tool theme
  observing: 'idle',               // neutral default
  discernment_opportunity: 'tool', // just applied AI output — review nudge incoming
};

// Phrases shown in the collapsed avatar bubble for each status.
// Design principles:
//   • State what was observed ("I noticed…", "Looks like…") — not commands.
//   • For stuck: always include one phrase pointing to asking for help,
//     so users know they can reach out directly.
//   • For observing: reassure that the system is alive and watching.
//   • For discernment_opportunity: hint that a review nudge is coming.
export const PHRASES: Record<ObservationStatus, string[]> = {
  progress: [
    'Making good progress',
    'Looking good — keep it up',
    'Things are moving along',
    'Solid work so far',
    'On track',
    'Good momentum here',
    'Flowing nicely',
  ],
  stuck: [
    'Looks like a tricky spot — you can ask me for help',
    'Seems like you might be stuck — feel free to ask me',
    'Taking a while here — I\'m here if you need a hint',
    'Hitting a wall? You can always ask me directly',
    'Tough moment. Take your time. If you want a hand, just ask!',
  ],
  mistake: [
    'Something looks worth double-checking',
    'There might be a snag in here',
    'I noticed something that may need a second look',
    'Might be worth pausing to verify this',
  ],
  inefficient: [
    'I noticed this could be faster with AI',
    'Looks like there may be an easier way here',
    'A lot of manual work — AI might help with this',
    'This kind of task is something AI is good at',
  ],
  ai_struggle: [
    'The prompt might need a tweak',
    'Looks like the AI output needs some work',
    'Might help to reframe what you\'re asking',
    'The AI may need a clearer instruction here',
  ],
  observing: [
    'Keeping an eye on your work',
    'Nothing unusual — I\'m here if you need me',
    'Monitoring in the background',
    'Still tracking — looking good',
  ],
  discernment_opportunity: [
    'You just applied AI output — quick review recommended',
    'AI content applied — worth a scan before moving on',
    'Looks like you used AI output — I\'ll share a quick tip',
  ],
};

export const STATUS_LABEL: Record<ObservationStatus, string> = {
  progress: 'Progress',
  stuck: 'Stuck?',
  mistake: 'Heads up',
  inefficient: 'AI could help',
  ai_struggle: 'AI hiccup',
  observing: 'Watching',
  discernment_opportunity: 'Review AI output',
};

export function pickPhrase(status: ObservationStatus, seed: number): string {
  const pool = PHRASES[status] ?? PHRASES.observing;
  return pool[Math.abs(seed) % pool.length];
}

/**
 * The sensing server sometimes emits the observation as a raw JSON string
 * (e.g. `{ "observation": "The user is…" }`) or prefixes it with bracketed
 * metadata (e.g. `[inefficiency trigger — none] { "observation": "…" }`).
 * This helper extracts just the human-readable text. Shared by the renderer
 * (bubble) and the main process (activity store) so both persist clean text.
 *
 * Order matters: strip brackets first so the JSON check sees a clean string.
 */
export function cleanObservation(raw: string): string {
  // 1. Strip any leading bracketed metadata, e.g. [inefficiency trigger — none].
  let text = raw.trim().replace(/^\[.*?\]\s*/, '').trim();

  // 2. If there's a JSON object present, extract the "observation" field.
  if (text.includes('"observation"')) {
    try {
      // Find the outermost {...} in the string (handles surrounding text).
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.observation === 'string' && parsed.observation) {
          return parsed.observation.trim();
        }
      }
    } catch {
      // Fallback regex — handles malformed JSON.
      const m = text.match(/"observation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
    }
  }

  return text;
}

// ── Activity lanes ───────────────────────────────────────────────────────────
// The 7 raw statuses collapse into 4 user-facing "lanes". Lanes are the unit
// the Activity panel speaks in: they drive dot colors, the flow timeline, and
// every rolled-up metric, so timeline / dots / counts can never drift apart.

export type ActivityLane = 'flow' | 'watching' | 'focus' | 'assist';

export const STATUS_TO_LANE: Record<ObservationStatus, ActivityLane> = {
  progress: 'flow', // producing, on track
  observing: 'watching', // neutral background
  stuck: 'focus', // slowed down — a hard, normal part of working
  mistake: 'focus', // worth a second look
  inefficient: 'assist', // AI could help
  ai_struggle: 'assist', // AI tool needs a tweak
  discernment_opportunity: 'assist', // review AI output
};

export const LANE_LABEL: Record<ActivityLane, string> = {
  flow: 'Flow',
  watching: 'Watching',
  focus: 'Focus moment',
  assist: 'AI assist',
};

// Single source of truth for lane colors. Amber (not red) for focus moments —
// stuck/mistake are normal, not failures. CSS mirrors these via .obs-lane--*.
export const LANE_COLOR: Record<ActivityLane, string> = {
  flow: '#22c55e', // green
  watching: '#94a3b8', // soft gray
  focus: '#f59e0b', // amber
  assist: '#6366f1', // blue/violet
};

export function laneOf(status: ObservationStatus): ActivityLane {
  return STATUS_TO_LANE[status] ?? 'watching';
}

// ── Activity history ─────────────────────────────────────────────────────────

/** The minimal record persisted to disk (one per observation event). */
export interface ActivityRecord {
  /** Unix timestamp (seconds). */
  ts: number;
  status: ObservationStatus;
  /** Cleaned, human-readable observation text. */
  observation: string;
  llm_metrics?: LLMCallMetrics;
}


export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

/** Clock time like "12:30" for timeline markers and the recent-events list. */
export function formatClockTime(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h}:${m.toString().padStart(2, '0')}`;
}

/** Human duration like "6m", "1h 48m", "47s". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
