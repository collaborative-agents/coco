import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  AI_TOOLS,
  parseAiTool,
  encodeCustomChatbot,
  encodeCustomAgent,
} from './observation-types';
import type { LLMCallMetrics } from './observation-types';

// Platform-appropriate label for the global screen-capture hot key
// (registered in main.ts as CommandOrControl+Shift+Space).
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const HOTKEY_LABEL = IS_MAC ? 'Cmd + Shift + Space' : 'Ctrl + Shift + Space';

// ── Tutor guidance parsing ─────────────────────────────────────────────────────
// The local tutor server returns a JSON envelope string, e.g.
//   {"guidance": "...", "example_prompt": "...", "visualization_code": "<html>"}
// We extract the readable fields; if the payload isn't JSON we show it verbatim.

interface Guidance {
  text: string;
  examplePrompt?: string | null;
  vizCode?: string | null;
}

/** Scan for the first balanced {...} block, respecting strings and escapes. */
function extractJsonObject(text: string): string | null {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }
      if (ch === '"') inString = !inString;
      if (!inString) {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/** LLMs embed LaTeX (\frac …) in JSON strings unescaped — repair before parse. */
function repairJsonEscapes(text: string): string {
  const structural = new Set(['"', '\\', '/']);
  const ambiguous = new Set(['b', 'f', 'n', 'r', 't']);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const nxt = text[i + 1];
      if (structural.has(nxt)) { out.push(text[i], nxt); i += 2; continue; }
      if (nxt === 'u' && i + 5 < text.length && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out.push(text.slice(i, i + 6)); i += 6; continue;
      }
      if (ambiguous.has(nxt)) {
        const after = i + 2 < text.length ? text[i + 2] : '';
        if (/[a-zA-Z]/.test(after)) { out.push('\\\\'); i += 1; continue; }
        out.push(text[i], nxt); i += 2; continue;
      }
      out.push('\\\\'); i += 1; continue;
    }
    out.push(text[i]); i += 1;
  }
  return out.join('');
}

function parseGuidance(raw: string): Guidance {
  const tryParse = (s: string): any => {
    try { return JSON.parse(s); } catch {
      try { return JSON.parse(repairJsonEscapes(s)); } catch { return null; }
    }
  };
  let obj: any = tryParse(raw.trim());
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence) obj = tryParse(fence[1].trim());
  }
  if (!obj) {
    const block = extractJsonObject(raw);
    if (block) obj = tryParse(block);
  }
  if (obj && typeof obj === 'object') {
    const text = obj.guidance ?? obj['Text guidance'] ?? '';
    const example = obj.example_prompt ?? obj.examplePrompt ?? null;
    const viz = obj.visualization_code ?? obj.visualizationCode ?? null;
    return {
      text: String(text || raw),
      examplePrompt:
        example && String(example).toLowerCase() !== 'not applicable'
          ? String(example)
          : null,
      vizCode: viz ? String(viz) : null,
    };
  }
  return { text: raw };
}

// Hide fenced python/visualization code from the chat prose.
const VIZ_CODE_LANGS = new Set(['python', 'py']);
const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  code({ inline, className, children, ...props }: any) {
    const lang = /language-(\w+)/.exec(className || '')?.[1]?.toLowerCase();
    if (!inline && lang && VIZ_CODE_LANGS.has(lang)) return null;
    return <code className={className} {...props}>{children}</code>;
  },
  a({ href, children, ...props }: any) {
    return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
  },
};

// ── Message model ──────────────────────────────────────────────────────────────
interface ChatMessage {
  role: 'user' | 'tutor';
  text: string;
  images?: string[];
  isError?: boolean;
  /** Stable id for tutor messages so thumbs feedback can reference them. */
  id?: string;
  /** When the message was appended — lets latency_s capture time-to-rate. */
  ts?: number;
  observerMetrics?: LLMCallMetrics | null;
  tutorMetrics?: LLMCallMetrics | null;
}

// crypto.randomUUID needs a secure context; fall back for safety.
const makeMessageId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function formatMetricTokens(n?: number): string {
  if (typeof n !== 'number') return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatMetricLatency(ms?: number): string {
  if (typeof ms !== 'number') return '0s';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

// ── Styles (inline so the view is self-contained in a transparent window) ──────
// Palette mirrors the onboarding panel: SALT Lab blue with a light-blue accent.
const ACCENT = '#204A79'; // primary blue
const ACCENT_BG = '#E9EFFF'; // light blue fill
const ACCENT_BORDER = '#BCD0FC'; // light blue border
const BORDER = '#e5e7eb';
const FONT = "'PT Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100vh',
    fontFamily: FONT,
    background: '#ffffff', borderRadius: 14, overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: `1px solid ${BORDER}`,
    color: '#111827',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
    background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
    WebkitAppRegion: 'drag', // draggable region for the frameless window
  } as React.CSSProperties,
  brand: { display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13, color: '#374151' },
  statusDot: { width: 8, height: 8, borderRadius: '50%', background: '#22c55e' },
  sub: { fontSize: 11, color: '#9ca3af', fontWeight: 400 },
  headerBtns: { marginLeft: 'auto', display: 'flex', gap: 2, WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  iconBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    fontSize: 15, color: '#9ca3af', padding: '3px 7px', borderRadius: 7,
  },
  iconBtnActive: { background: ACCENT_BG, color: ACCENT },
  problem: { padding: '6px 14px', fontSize: 11, color: '#9ca3af', borderBottom: `1px solid #f3f4f6`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  list: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  userRow: { alignSelf: 'flex-end', maxWidth: '85%' },
  tutorRow: { alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', gap: 8 },
  tutorAvatar: { width: 24, height: 24, borderRadius: '50%', background: ACCENT, color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 },
  userBubble: { background: ACCENT, color: '#fff', padding: '9px 13px', borderRadius: '16px 16px 4px 16px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tutorBubble: { background: '#f3f4f6', color: '#374151', padding: '9px 13px', borderRadius: '4px 16px 16px 16px', fontSize: 13, lineHeight: 1.5 },
  errBubble: { background: '#fef2f2', color: '#b91c1c', padding: '9px 13px', borderRadius: 12, fontSize: 13, border: '1px solid #fecaca' },
  thumbRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  thumb: { width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${BORDER}` },
  example: { marginTop: 8, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 10, padding: '8px 10px', fontSize: 12, color: ACCENT },
  exampleBtn: { marginTop: 6, border: `1px solid ${ACCENT_BORDER}`, background: '#fff', borderRadius: 8, padding: '3px 9px', fontSize: 11, cursor: 'pointer', color: ACCENT },
  viz: { marginTop: 8, width: '100%', height: 280, border: `1px solid ${BORDER}`, borderRadius: 10, background: '#fff' },
  composer: { borderTop: `1px solid ${BORDER}`, padding: 10, background: '#fff' },
  pending: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  pendingThumbWrap: { position: 'relative' },
  pendingX: { position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: '#374151', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 10, lineHeight: '16px', padding: 0 },
  inputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  textarea: { flex: 1, resize: 'none', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '9px 11px', fontSize: 13, fontFamily: FONT, maxHeight: 120, outline: 'none', color: '#111827' },
  sendBtn: { border: 'none', background: ACCENT, color: '#fff', borderRadius: 12, padding: '9px 15px', fontSize: 13, cursor: 'pointer', fontWeight: 700, fontFamily: FONT },
  sendBtnDisabled: { opacity: 0.4, cursor: 'default' },
  hotkeyHint: { marginTop: 6, fontSize: 11, color: '#9ca3af', fontFamily: FONT, textAlign: 'center' },
  hotkeyKbd: { fontFamily: FONT, fontWeight: 600, color: '#6b7280', background: '#f3f4f6', border: `1px solid ${BORDER}`, borderRadius: 5, padding: '1px 5px', fontSize: 10.5 },
  feedbackRow: { display: 'flex', gap: 2, marginTop: 4 },
  metricRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, color: '#6b7280', fontSize: 10.5 },
  metricChip: { border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 6, padding: '1px 5px', lineHeight: 1.35 },
  feedbackBtn: { border: '1px solid transparent', background: 'transparent', borderRadius: 6, padding: '0 5px', fontSize: 12, lineHeight: '20px', cursor: 'pointer', opacity: 0.45 },
  feedbackBtnRated: { opacity: 1, background: ACCENT_BG, borderColor: ACCENT_BORDER, cursor: 'default' },
  feedbackBtnLocked: { opacity: 0.25, cursor: 'default' },
  typing: { alignSelf: 'flex-start', color: '#9ca3af', fontSize: 12, fontStyle: 'italic', paddingLeft: 32 },
  empty: { margin: 'auto', textAlign: 'center', color: '#9ca3af', fontSize: 12.5, lineHeight: 1.6, padding: 24 },
  // Settings panel (mirrors the onboarding toolkit step)
  settings: { borderBottom: `1px solid ${BORDER}`, background: '#ffffff', padding: '14px', maxHeight: 360, overflowY: 'auto' },
  toggleRow: { display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', marginBottom: 14 },
  toggleTitle: { display: 'block', fontSize: 13, color: '#374151', marginBottom: 2 },
  toggleHelp: { display: 'block', fontSize: 11.5, lineHeight: 1.4, color: '#9ca3af' },
  groupLabel: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: ACCENT, marginBottom: 6 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 },
  chip: { fontSize: 13, fontWeight: 500, padding: '6px 14px', borderRadius: 999, background: '#fff', border: '1.5px solid #d1d5db', color: '#4b5563', cursor: 'pointer', fontFamily: FONT },
  chipOn: { background: ACCENT, borderColor: ACCENT, color: '#fff' },
  chipDashed: { borderStyle: 'dashed', color: '#9ca3af' },
  chipEmpty: { fontSize: 12, color: '#9ca3af', fontStyle: 'italic' },
  customForm: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: -6, marginBottom: 14 },
  customInput: { width: '100%', border: '1.5px solid #d1d5db', borderRadius: 8, padding: '7px 11px', fontSize: 13, color: '#374151', outline: 'none', fontFamily: FONT, boxSizing: 'border-box' },
  memoryArea: { width: '100%', minHeight: 96, resize: 'vertical', border: '1.5px solid #d1d5db', borderRadius: 8, padding: '8px 11px', fontSize: 13, lineHeight: 1.5, color: '#374151', outline: 'none', fontFamily: FONT, boxSizing: 'border-box', marginBottom: 8 },
  sectionDivider: { height: 1, background: '#f3f4f6', margin: '4px 0 14px' },
  helpText: { fontSize: 11.5, color: '#9ca3af', lineHeight: 1.5, marginBottom: 8 },
  addBtn: { alignSelf: 'flex-start', border: 'none', background: ACCENT, color: '#fff', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: FONT },
  saveRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 },
  saveBtn: { border: 'none', background: ACCENT, color: '#fff', borderRadius: 999, padding: '7px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT },
  saved: { fontSize: 12, color: '#16a34a', fontWeight: 700 },
};

const CHATBOTS = Object.values(AI_TOOLS).filter((t) => t.category === 'chatbot');
const AGENTS = Object.values(AI_TOOLS).filter((t) => t.category === 'agent');
const MODE_OPTIONS = [
  { id: 'everyday_support', label: 'Everyday Support' },
  { id: 'student_learning', label: 'Student Learning' },
];

function TutorMessage({ text }: { text: string }) {
  const g = parseGuidance(text);
  return (
    <div>
      <div className="chat-markdown">
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={markdownComponents}
        >
          {g.text}
        </Markdown>
      </div>
      {g.vizCode && (
        // eslint-disable-next-line react/no-danger-with-children
        <iframe title="visualization" style={S.viz} sandbox="allow-scripts" srcDoc={g.vizCode} />
      )}
      {g.examplePrompt && (
        <div style={S.example}>
          <div style={{ fontWeight: 600, marginBottom: 2, color: '#3355cc' }}>Try this prompt</div>
          {g.examplePrompt}
          <div>
            <button
              type="button"
              style={S.exampleBtn}
              onClick={() => navigator.clipboard.writeText(g.examplePrompt || '')}
            >
              Copy prompt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatMetrics({
  observerMetrics,
  tutorMetrics,
}: {
  observerMetrics?: LLMCallMetrics | null;
  tutorMetrics?: LLMCallMetrics | null;
}) {
  const metrics = [observerMetrics, tutorMetrics].filter(
    (m): m is LLMCallMetrics => Boolean(m),
  );
  if (metrics.length === 0) return null;

  const inputTokens = metrics.reduce(
    (total, m) => total + (m.input_tokens ?? m.prompt_tokens ?? 0),
    0,
  );
  const outputTokens = metrics.reduce(
    (total, m) => total + (m.output_tokens ?? m.completion_tokens ?? 0),
    0,
  );
  const durationMs = metrics.reduce(
    (total, m) => total + (m.duration_ms ?? 0),
    0,
  );

  return (
    <div style={S.metricRow}>
      <span style={S.metricChip}>
        {formatMetricTokens(inputTokens)} in / {formatMetricTokens(outputTokens)}{' '}
        out / {formatMetricLatency(durationMs)}
      </span>
    </div>
  );
}

export default function SessionChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [profile, setProfile] = useState<{
    scenario: string;
    aiTools: string[];
    hideAvatar: boolean;
  }>({
    scenario: 'everyday_support',
    aiTools: [],
    hideAvatar: false,
  });
  // Editable draft of the settings, synced from the loaded profile.
  const [editScenario, setEditScenario] = useState('everyday_support');
  const [editTools, setEditTools] = useState<string[]>([]);
  const [editHideAvatar, setEditHideAvatar] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // "+ Custom" tool forms (mirrors the onboarding toolkit step).
  const [showAddChatbot, setShowAddChatbot] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [cbName, setCbName] = useState('');
  const [cbUrl, setCbUrl] = useState('');
  const [cbDesc, setCbDesc] = useState('');
  const [agName, setAgName] = useState('');
  const [agDesc, setAgDesc] = useState('');
  // Long-term agent memory (loaded from / saved to the tutor server).
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryLoaded, setMemoryLoaded] = useState('');
  const [memoryFlash, setMemoryFlash] = useState(false);
  // One thumbs vote per tutor message, keyed by message id.
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down'>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Rate a tutor message. Routed main → sensing /feedback → feedback.jsonl,
  // same pipeline as the bubble reactions.
  const rateMessage = (m: ChatMessage, dir: 'up' | 'down') => {
    if (!m.id || ratings[m.id]) return;
    setRatings((prev) => ({ ...prev, [m.id as string]: dir }));
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      surface: 'chat',
      message_id: m.id,
      session_id: sessionIdRef.current,
      latency_s: m.ts ? (Date.now() - m.ts) / 1000 : null,
      text: m.text,
    });
  };

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, []);

  // Core send: appends the user turn, calls the local tutor via IPC, appends
  // the tutor's reply. Text and/or pasted images are both optional.
  const sendMessage = useCallback(
    async (text: string, images: string[]) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      setMessages((m) => [...m, { role: 'user', text: trimmed, images }]);
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer.invoke('send-chat-message', {
        userText: trimmed,
        images,
      });
      setSending(false);
      const r = res as {
        guidance?: string;
        error?: string;
        observerMetrics?: LLMCallMetrics | null;
        tutorMetrics?: LLMCallMetrics | null;
      } | undefined;
      if (r?.error) {
        setMessages((m) => [...m, { role: 'tutor', text: r.error as string, isError: true }]);
      } else {
        setMessages((m) => [
          ...m,
          {
            role: 'tutor',
            text: r?.guidance ?? '',
            id: makeMessageId(),
            ts: Date.now(),
            observerMetrics: r?.observerMetrics ?? null,
            tutorMetrics: r?.tutorMetrics ?? null,
          },
        ]);
      }
      scrollToBottom();
    },
    [scrollToBottom],
  );

  // Session context from main. A new sessionId resets the conversation.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('session-init', (data: any) => {
      const { sessionId, problemStatement } = (data ?? {}) as {
        sessionId?: string;
        problemStatement?: string;
      };
      if (sessionId && sessionId !== sessionIdRef.current) {
        sessionIdRef.current = sessionId;
        setMessages([]);
        setRatings({});
      }
      setProblem(problemStatement ?? '');
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  // Load the user's onboarding profile (mode + AI tools) for the Settings panel.
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((p: any) => {
        if (!p) return;
        const next = {
          scenario: typeof p.tutorScenario === 'string' ? p.tutorScenario : 'everyday_support',
          aiTools: Array.isArray(p.aiTools) ? p.aiTools : [],
          hideAvatar: p.hideAvatar === true,
        };
        setProfile(next);
        setEditScenario(next.scenario);
        setEditTools(next.aiTools);
        setEditHideAvatar(next.hideAvatar);
      })
      .catch(() => {});
  }, []);

  const toggleEditTool = (id: string) =>
    setEditTools((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  const addCustomChatbot = () => {
    if (!cbName.trim() || !cbUrl.trim()) return;
    setEditTools((prev) => [...prev, encodeCustomChatbot(cbName, cbUrl, cbDesc)]);
    setCbName('');
    setCbUrl('');
    setCbDesc('');
    setShowAddChatbot(false);
  };
  const addCustomAgent = () => {
    if (!agName.trim()) return;
    setEditTools((prev) => [...prev, encodeCustomAgent(agName, agDesc)]);
    setAgName('');
    setAgDesc('');
    setShowAddAgent(false);
  };
  // Display label for a custom-tool id (parseAiTool resolves custom chatbots;
  // custom agents carry no launch target, so decode the name from the id).
  const customLabel = (id: string) =>
    parseAiTool(id)?.label ??
    id.replace(/^custom_(chatbot|agent):/, '').split('|')[0] ??
    id;

  const saveSettings = async () => {
    const res = await window.electron?.ipcRenderer.invoke('update-settings', {
      scenario: editScenario,
      aiTools: editTools,
      hideAvatar: editHideAvatar,
    });
    if ((res as { success?: boolean })?.success) {
      setProfile({
        scenario: editScenario,
        aiTools: editTools,
        hideAvatar: editHideAvatar,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    }
  };

  const dirty =
    editScenario !== profile.scenario ||
    editHideAvatar !== profile.hideAvatar ||
    editTools.length !== profile.aiTools.length ||
    editTools.some((t) => !profile.aiTools.includes(t));

  // Load the agent memory whenever the Settings panel is opened.
  useEffect(() => {
    if (!showSettings) return;
    window.electron?.ipcRenderer
      .invoke('get-memory')
      .then((r: any) => {
        const mem = String(r?.memory ?? '');
        setMemoryDraft(mem);
        setMemoryLoaded(mem);
      })
      .catch(() => {});
  }, [showSettings]);

  const saveMemory = async () => {
    const res = await window.electron?.ipcRenderer.invoke('save-memory', { memory: memoryDraft });
    if ((res as { success?: boolean })?.success) {
      setMemoryLoaded(memoryDraft);
      setMemoryFlash(true);
      setTimeout(() => setMemoryFlash(false), 1500);
    }
  };
  const memoryDirty = memoryDraft !== memoryLoaded;

  // "Help me with this" seed — auto-send the observation as the first message.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('help-request', (data: any) => {
      const { rawObservation, phrase } = (data ?? {}) as { rawObservation?: string; phrase?: string };
      const seed = (rawObservation || phrase || '').trim();
      if (seed) sendMessage(seed, []);
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, [sendMessage]);

  // Hot-key screen capture (Cmd/Ctrl+Shift+Space) → preview thumbnail in the
  // input bar, reusing the same pending-image strip that paste drives.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('hotkey-capture', (data: any) => {
      const url = (data ?? {}).imageDataUrl as string | undefined;
      if (url) setPendingImages((prev) => [...prev, url]);
    });
    // Tell main the listener is live so it can flush any capture that arrived
    // while this window was still loading (e.g. the hot key just opened it).
    window.electron?.ipcRenderer.sendMessage('hotkey-capture-ready');
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => setPendingImages((prev) => [...prev, String(reader.result)]);
        reader.readAsDataURL(file);
      }
    }
  };

  const handleSend = () => {
    if (sending) return;
    const imgs = pendingImages;
    const text = input;
    setInput('');
    setPendingImages([]);
    sendMessage(text, imgs);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = !sending && (input.trim().length > 0 || pendingImages.length > 0);

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.brand}>
          <span style={S.statusDot} /> Coco <span style={S.sub}>· Session active</span>
        </span>
        <div style={S.headerBtns}>
          <button
            type="button"
            style={{ ...S.iconBtn, ...(showSettings ? S.iconBtnActive : {}) }}
            title="Settings"
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙
          </button>
          <button
            type="button"
            style={S.iconBtn}
            title={expanded ? 'Collapse' : 'Expand'}
            onClick={() => {
              setExpanded((v) => !v);
              window.electron?.ipcRenderer.sendMessage('toggle-float-window');
            }}
          >
            {expanded ? '⇥' : '⇤'}
          </button>
          <button type="button" style={S.iconBtn} title="Close" onClick={() => window.close()}>
            ×
          </button>
        </div>
      </div>

      {showSettings && (
        <div style={S.settings}>
          <div style={S.groupLabel}>Desktop</div>
          <label style={S.toggleRow} htmlFor="hide-desktop-avatar">
            <input
              id="hide-desktop-avatar"
              type="checkbox"
              checked={editHideAvatar}
              onChange={(e) => setEditHideAvatar(e.target.checked)}
            />
            <span>
              <strong style={S.toggleTitle}>Hide desktop avatar</strong>
              <span style={S.toggleHelp}>
                Keep Coco in the system tray and show proactive suggestions as
                notifications.
              </span>
            </span>
          </label>

          <div style={S.sectionDivider} />

          <div style={S.groupLabel}>Agent mode</div>
          <div style={S.chips}>
            {MODE_OPTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                style={{ ...S.chip, ...(editScenario === m.id ? S.chipOn : {}) }}
                onClick={() => setEditScenario(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div style={S.groupLabel}>AI Chatbots</div>
          <div style={S.chips}>
            {CHATBOTS.map((t) => (
              <button
                key={t.id}
                type="button"
                style={{ ...S.chip, ...(editTools.includes(t.id) ? S.chipOn : {}) }}
                onClick={() => toggleEditTool(t.id)}
              >
                {t.label}
              </button>
            ))}
            {/* Any custom chatbots already added */}
            {editTools
              .filter((id) => id.startsWith('custom_chatbot:'))
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  style={{ ...S.chip, ...S.chipOn }}
                  title="Click to remove"
                  onClick={() => toggleEditTool(id)}
                >
                  {customLabel(id)} ✕
                </button>
              ))}
            <button
              type="button"
              style={{ ...S.chip, ...S.chipDashed }}
              onClick={() => setShowAddChatbot((v) => !v)}
            >
              + Custom
            </button>
          </div>
          {showAddChatbot && (
            <div style={S.customForm}>
              <input style={S.customInput} placeholder="Name — e.g. DeepSeek" value={cbName} onChange={(e) => setCbName(e.target.value)} />
              <input style={S.customInput} placeholder="Website URL — e.g. https://chat.deepseek.com/" value={cbUrl} onChange={(e) => setCbUrl(e.target.value)} />
              <input style={S.customInput} placeholder="Description (optional) — what it's good at" value={cbDesc} onChange={(e) => setCbDesc(e.target.value)} />
              <button type="button" style={S.addBtn} onClick={addCustomChatbot}>Add chatbot</button>
            </div>
          )}

          <div style={S.groupLabel}>AI Agents</div>
          <div style={S.chips}>
            {AGENTS.map((t) => (
              <button
                key={t.id}
                type="button"
                style={{ ...S.chip, ...(editTools.includes(t.id) ? S.chipOn : {}) }}
                onClick={() => toggleEditTool(t.id)}
              >
                {t.label}
              </button>
            ))}
            {editTools
              .filter((id) => id.startsWith('custom_agent:'))
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  style={{ ...S.chip, ...S.chipOn }}
                  title="Click to remove"
                  onClick={() => toggleEditTool(id)}
                >
                  {customLabel(id)} ✕
                </button>
              ))}
            <button
              type="button"
              style={{ ...S.chip, ...S.chipDashed }}
              onClick={() => setShowAddAgent((v) => !v)}
            >
              + Custom
            </button>
          </div>
          {showAddAgent && (
            <div style={S.customForm}>
              <input style={S.customInput} placeholder="Name — e.g. internal automation tool" value={agName} onChange={(e) => setAgName(e.target.value)} />
              <input style={S.customInput} placeholder="Description (optional) — what it does" value={agDesc} onChange={(e) => setAgDesc(e.target.value)} />
              <button type="button" style={S.addBtn} onClick={addCustomAgent}>Add agent</button>
            </div>
          )}

          <div style={S.saveRow}>
            <button
              type="button"
              style={{ ...S.saveBtn, ...(dirty ? {} : S.sendBtnDisabled) }}
              onClick={saveSettings}
              disabled={!dirty}
            >
              Save changes
            </button>
            {savedFlash && <span style={S.saved}>✓ Saved &amp; applied</span>}
          </div>

          <div style={S.sectionDivider} />

          <div style={S.groupLabel}>Memory</div>
          <div style={S.helpText}>
            Long-term notes Coco keeps about you — preferences, recurring tasks,
            and what has worked before. Coco reads this every session; edit it
            freely.
          </div>
          <textarea
            style={S.memoryArea}
            placeholder="e.g. Prefers concise answers. Works mostly in Google Docs and Slides. Comfortable with Claude; new to agents."
            value={memoryDraft}
            onChange={(e) => setMemoryDraft(e.target.value)}
          />
          <div style={S.saveRow}>
            <button
              type="button"
              style={{ ...S.saveBtn, ...(memoryDirty ? {} : S.sendBtnDisabled) }}
              onClick={saveMemory}
              disabled={!memoryDirty}
            >
              Save memory
            </button>
            {memoryFlash && <span style={S.saved}>✓ Saved</span>}
          </div>
        </div>
      )}

      {problem && <div style={S.problem}>Task: {problem}</div>}

      <div style={S.list} ref={listRef}>
        {messages.length === 0 && !sending && (
          <div style={S.empty}>
            Ask Coco about your task, an AI tool, or anything else.
            <br />
            You can paste a screenshot to show what you&apos;re working on.
          </div>
        )}
        {messages.map((m, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={m.role === 'user' ? S.userRow : S.tutorRow}>
            {m.role === 'user' ? (
              <div style={S.userBubble}>
                {m.text}
                {m.images && m.images.length > 0 && (
                  <div style={S.thumbRow}>
                    {m.images.map((src, j) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <img key={j} src={src} alt="pasted" style={S.thumb} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div style={S.tutorAvatar}>C</div>
                <div>
                  <div style={m.isError ? S.errBubble : S.tutorBubble}>
                    {m.isError ? m.text : <TutorMessage text={m.text} />}
                  </div>
                  {!m.isError && (
                    <ChatMetrics
                      observerMetrics={m.observerMetrics}
                      tutorMetrics={m.tutorMetrics}
                    />
                  )}
                  {!m.isError && m.id && (
                    <div style={S.feedbackRow}>
                      {(['up', 'down'] as const).map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          aria-label={dir === 'up' ? 'Helpful' : 'Not helpful'}
                          title={dir === 'up' ? 'Helpful' : 'Not helpful'}
                          disabled={!!ratings[m.id as string]}
                          style={{
                            ...S.feedbackBtn,
                            ...(ratings[m.id as string] === dir
                              ? S.feedbackBtnRated
                              : ratings[m.id as string]
                                ? S.feedbackBtnLocked
                                : {}),
                          }}
                          onClick={() => rateMessage(m, dir)}
                        >
                          {dir === 'up' ? '👍' : '👎'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        {sending && <div style={S.typing}>Coco is thinking…</div>}
      </div>

      <div style={S.composer}>
        {pendingImages.length > 0 && (
          <div style={S.pending}>
            {pendingImages.map((src, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} style={S.pendingThumbWrap}>
                <img src={src} alt="pending" style={S.thumb} />
                <button
                  type="button"
                  style={S.pendingX}
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={S.inputRow}>
          <textarea
            style={S.textarea}
            rows={2}
            placeholder="Ask the tutor… (paste an image to attach)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            style={{ ...S.sendBtn, ...(canSend ? {} : S.sendBtnDisabled) }}
            onClick={handleSend}
            disabled={!canSend}
          >
            Send
          </button>
        </div>
        <div style={S.hotkeyHint}>
          Press <span style={S.hotkeyKbd}>{HOTKEY_LABEL}</span> anytime to grab a screenshot
        </div>
      </div>
    </div>
  );
}
