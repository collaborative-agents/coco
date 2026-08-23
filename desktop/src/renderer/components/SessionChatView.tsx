import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  startVoiceRecorder,
  type ActiveVoiceRecorder,
  type VoiceRecorderStatus,
} from '../voice-recorder';
import {
  AI_TOOLS,
  parseAiTool,
  encodeCustomChatbot,
  encodeCustomAgent,
} from './observation-types';
import type { LLMCallMetrics, TutorToolCall } from './observation-types';

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

interface WakeWordSettingsInfo {
  enabled: boolean;
  keywords: string[];
  status: 'disabled' | 'starting' | 'ready' | 'sleeping' | 'error';
  detail?: string;
  logPath?: string;
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

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
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
  toolCalls?: TutorToolCall[];
  /** Correlates incremental main-process events with this pending reply. */
  requestId?: string;
  isStreaming?: boolean;
  /** Exact request payload retained so an error can be retried in place. */
  retryText?: string;
  retryImages?: string[];
  retryHotkeyImages?: string[];
}

function copyableMessageText(message: ChatMessage): string {
  if (message.role === 'tutor' && !message.isError) {
    return parseGuidance(message.text).text;
  }
  return message.text;
}

function messageCopyKey(message: ChatMessage, index: number): string {
  return `${message.role}:${message.id ?? message.ts ?? index}`;
}

interface SavedConversation {
  sessionId: string;
  title?: string;
  problem: string;
  createdAt: number;
  updatedAt: number;
  tutorModelId?: string;
  messages: ChatMessage[];
}

interface TutorModelOption {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
}

interface ServiceHealth {
  connected: boolean;
  status: string;
  detail?: string;
  totalActions?: number;
  modelAssessment?: {
    status: 'verified' | 'failed' | 'legacy_unassessed' | 'not_configured';
    detail: string;
  };
}

interface ServiceHealthView {
  checkedAt: number;
  sensing: ServiceHealth;
  tutor: ServiceHealth;
}

interface SleepingServiceHealthView {
  checkedAt: number;
  sleeping: true;
}

interface ConnectionTestStatus {
  state: 'testing' | 'success' | 'error';
  message: string;
}

const MODEL_PROVIDER_OPTIONS = [
  ['gemini', 'Google Gemini'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['tinker', 'Tinker'],
  ['tinfoil', 'Tinfoil'],
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio'],
] as const;
const MODEL_ENDPOINT_PROVIDERS = new Set(['hosted_vllm', 'lm_studio']);

const blankSensingModel = (): TutorModelOption => ({
  id: 'sensing',
  label: 'Sensing',
  provider: 'gemini',
  model: '',
});

const blankTutorModel = (): TutorModelOption => ({
  id: 'tutor-1',
  label: 'Primary tutor',
  provider: 'anthropic',
  model: '',
});

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
  contentViewport: { flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' },
  scalableContent: { display: 'flex', flexDirection: 'column', minHeight: 0, transformOrigin: 'top left' },
  header: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
    background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
    WebkitAppRegion: 'drag', // draggable region for the frameless window
  } as React.CSSProperties,
  brand: { display: 'flex', alignItems: 'center', gap: 7, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', fontWeight: 700, fontSize: 13, color: '#374151' },
  statusDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  sub: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, color: '#9ca3af', fontWeight: 400 },
  healthHeaderButton: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: 11, lineHeight: 1.2, fontWeight: 700, whiteSpace: 'nowrap', WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  headerBtns: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  modelSelect: {
    width: 120, minWidth: 120, maxWidth: 120,
    border: `1px solid ${ACCENT_BORDER}`, background: '#fff',
    color: ACCENT, borderRadius: 7, padding: '3px 6px', fontSize: 11,
    fontFamily: FONT, WebkitAppRegion: 'no-drag',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  } as React.CSSProperties,
  iconBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    fontSize: 15, color: '#9ca3af', padding: '3px 5px', borderRadius: 7,
  },
  iconBtnActive: { background: ACCENT_BG, color: ACCENT },
  newSessionBtn: {
    border: `1px solid ${ACCENT_BORDER}`, background: '#fff', cursor: 'pointer',
    fontSize: 11.5, color: ACCENT, padding: '3px 8px', borderRadius: 7,
    fontFamily: FONT, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
  },
  historyPanel: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff' },
  historyPanelHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${BORDER}` },
  historyTitle: { fontSize: 14, fontWeight: 700, color: '#374151' },
  historyBack: { border: 'none', background: 'transparent', color: ACCENT, cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 700, fontFamily: FONT },
  historyList: { flex: 1, overflowY: 'auto', padding: '8px 10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
  historyItem: { width: '100%', border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 10, padding: '9px 10px', textAlign: 'left', cursor: 'pointer', fontFamily: FONT },
  historyItemTitle: { display: 'block', color: '#374151', fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  historyItemMeta: { display: 'block', color: '#9ca3af', fontSize: 10.5, marginTop: 2 },
  historyItemPreview: { display: 'block', color: '#6b7280', fontSize: 11.5, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  reviewBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: ACCENT_BG, borderBottom: `1px solid ${ACCENT_BORDER}`, color: ACCENT, fontSize: 11.5 },
  problem: { padding: '6px 14px', fontSize: 11, color: '#9ca3af', borderBottom: `1px solid #f3f4f6`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  list: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  userRow: { alignSelf: 'flex-end', maxWidth: '85%' },
  tutorRow: { alignSelf: 'flex-start', maxWidth: '92%', display: 'flex', gap: 8 },
  tutorAvatar: { width: 24, height: 24, borderRadius: '50%', background: ACCENT, color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 },
  userBubble: { background: ACCENT, color: '#fff', padding: '9px 13px', borderRadius: '16px 16px 4px 16px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tutorBubble: { background: '#f3f4f6', color: '#374151', padding: '9px 13px', borderRadius: '4px 16px 16px 16px', fontSize: 13, lineHeight: 1.5 },
  errBubble: { background: '#fef2f2', color: '#b91c1c', padding: '9px 13px', borderRadius: 12, fontSize: 13, border: '1px solid #fecaca' },
  retryBtn: { marginTop: 7, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', borderRadius: 8, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: FONT },
  thumbRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  thumb: { width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${BORDER}` },
  example: { marginTop: 8, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 10, padding: '8px 10px', fontSize: 12, color: ACCENT },
  exampleBtn: { marginTop: 6, border: `1px solid ${ACCENT_BORDER}`, background: '#fff', borderRadius: 8, padding: '3px 9px', fontSize: 11, cursor: 'pointer', color: ACCENT },
  viz: { marginTop: 8, width: '100%', height: 280, border: `1px solid ${BORDER}`, borderRadius: 10, background: '#fff' },
  composer: { borderTop: `1px solid ${BORDER}`, padding: 10, background: '#fff' },
  composerModelRow: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 },
  composerModelLabel: { color: '#6b7280', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' },
  pendingContext: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '6px 8px', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 8, background: ACCENT_BG, color: ACCENT, fontSize: 11.5 },
  pendingContextText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pendingContextX: { border: 'none', background: 'transparent', color: ACCENT, cursor: 'pointer', padding: '0 2px', fontFamily: FONT, fontSize: 14, lineHeight: 1 },
  pending: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  pendingThumbWrap: { position: 'relative' },
  imagePreviewButton: { display: 'block', border: 'none', borderRadius: 8, padding: 0, background: 'transparent', cursor: 'zoom-in' },
  pendingX: { position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: '#374151', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 10, lineHeight: '16px', padding: 0 },
  pendingAnnotate: { position: 'absolute', left: 3, bottom: 3, height: 21, border: '1px solid rgba(255,255,255,0.72)', borderRadius: 6, padding: '0 6px', background: 'rgba(32,74,121,0.94)', color: '#fff', cursor: 'pointer', fontFamily: FONT, fontSize: 10, fontWeight: 700, lineHeight: '19px', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' },
  inputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  textarea: { flex: 1, resize: 'none', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '9px 11px', fontSize: 13, fontFamily: FONT, maxHeight: 120, outline: 'none', color: '#111827' },
  sendBtn: { border: 'none', background: ACCENT, color: '#fff', borderRadius: 12, padding: '9px 15px', fontSize: 13, cursor: 'pointer', fontWeight: 700, fontFamily: FONT },
  micBtn: {
    width: 38,
    height: 38,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: '#fff',
    color: '#374151',
    borderRadius: '50%',
    padding: 0,
    cursor: 'pointer',
    fontFamily: FONT,
    boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.14), 0 1px 3px rgba(15, 23, 42, 0.12)',
  },
  micBtnActive: {
    background: '#dc2626',
    color: '#fff',
    boxShadow: '0 0 0 4px #fff, 0 0 0 5px rgba(220, 38, 38, 0.2)',
  },
  voiceHint: { marginTop: 6, fontSize: 11, color: '#6b7280', fontFamily: FONT, textAlign: 'center' },
  voiceError: { marginTop: 6, fontSize: 11, color: '#b91c1c', fontFamily: FONT, textAlign: 'center' },
  sendBtnDisabled: { opacity: 0.4, cursor: 'default' },
  hotkeyHint: { marginTop: 6, fontSize: 11, color: '#9ca3af', fontFamily: FONT, textAlign: 'center' },
  hotkeyKbd: { fontFamily: FONT, fontWeight: 600, color: '#6b7280', background: '#f3f4f6', border: `1px solid ${BORDER}`, borderRadius: 5, padding: '1px 5px', fontSize: 10.5 },
  feedbackRow: { display: 'flex', gap: 2, marginTop: 4 },
  userMessageActions: { display: 'flex', justifyContent: 'flex-end', marginTop: 3 },
  copyMessageBtn: { border: 'none', background: 'transparent', borderRadius: 6, padding: '1px 5px', color: '#9ca3af', fontFamily: FONT, fontSize: 10.5, lineHeight: '18px', cursor: 'pointer' },
  copyMessageBtnDone: { color: '#16a34a', fontWeight: 700 },
  metricRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, color: '#6b7280', fontSize: 10.5 },
  metricChip: { border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 6, padding: '1px 5px', lineHeight: 1.35 },
  toolStack: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 7 },
  toolCard: { border: `1px solid ${ACCENT_BORDER}`, background: '#f8faff', borderRadius: 10, padding: '7px 9px', color: '#4b5563', fontSize: 11.5, lineHeight: 1.4 },
  toolHeader: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: ACCENT },
  toolIcon: { width: 18, height: 18, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: ACCENT_BG, fontSize: 11 },
  toolStatus: { marginLeft: 'auto', color: '#16a34a', fontWeight: 600, fontSize: 10.5 },
  toolStatusError: { color: '#b91c1c' },
  toolArgs: { marginTop: 3, color: '#6b7280' },
  toolDetails: { marginTop: 5 },
  toolObservation: { borderTop: `1px solid ${BORDER}`, marginTop: 5, paddingTop: 5 },
  feedbackBtn: { border: '1px solid transparent', background: 'transparent', borderRadius: 6, padding: '0 5px', fontSize: 12, lineHeight: '20px', cursor: 'pointer', opacity: 0.45 },
  feedbackBtnRated: { opacity: 1, background: ACCENT_BG, borderColor: ACCENT_BORDER, cursor: 'default' },
  typing: { alignSelf: 'flex-start', color: '#9ca3af', fontSize: 12, fontStyle: 'italic', paddingLeft: 32 },
  empty: { margin: 'auto', textAlign: 'center', color: '#9ca3af', fontSize: 12.5, lineHeight: 1.6, padding: 24 },
  // Settings panel (mirrors the onboarding toolkit step)
  settings: { borderBottom: `1px solid ${BORDER}`, background: '#ffffff', padding: '14px', maxHeight: 360, overflowY: 'auto' },
  healthList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 },
  healthRow: { display: 'flex', alignItems: 'flex-start', gap: 8, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 10px' },
  healthDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 4 },
  healthName: { fontSize: 12.5, fontWeight: 700, color: '#374151' },
  healthDetail: { fontSize: 10.5, color: '#9ca3af', marginTop: 2 },
  healthActions: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 },
  connectionTestRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  connectionTestButton: { border: `1px solid ${ACCENT_BORDER}`, background: '#fff', color: ACCENT, borderRadius: 8, padding: '5px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: FONT },
  connectionTestSuccess: { color: '#16a34a', fontSize: 11.5, fontWeight: 700 },
  connectionTestError: { width: '100%', color: '#b91c1c', fontSize: 11.5 },
  connectionTestErrorText: { maxHeight: 140, overflow: 'auto', margin: '6px 0 0', padding: 8, borderRadius: 7, background: '#fef2f2', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 10.5 },
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

export function ToolCallCard({ call }: { call: TutorToolCall }) {
  if (call.name === 'observe_screen') {
    const observation = call.result?.observation?.trim();
    return (
      <div style={S.toolCard}>
        <div style={S.toolHeader}>
          <span style={S.toolIcon}>▣</span>
          <span>Current screen</span>
          <span
            style={{
              ...S.toolStatus,
              ...(call.status === 'error' ? S.toolStatusError : {}),
            }}
          >
            {call.status === 'running'
              ? 'Observing…'
              : call.status === 'error'
                ? 'Unavailable'
                : 'Observed'}
          </span>
        </div>
        {call.arguments?.focus && (
          <div style={S.toolArgs}>{call.arguments.focus}</div>
        )}
        {call.result?.error && (
          <div style={{ ...S.toolArgs, ...S.toolStatusError }}>
            {call.result.error}
          </div>
        )}
        {observation && (
          <details style={S.toolDetails}>
            <summary>View screen observation</summary>
            <div style={S.toolObservation}>{observation}</div>
          </details>
        )}
      </div>
    );
  }

  const query = call.arguments?.query?.trim();
  const start = call.arguments?.start_hh_mm_ago;
  const end = call.arguments?.end_hh_mm_ago;
  const results = call.result?.results ?? [];
  const count = call.result?.count ?? results.length;
  const windowLabel = start || end
    ? `${start ?? 'any'} → ${end ?? 'now'} ago`
    : 'most recent';

  return (
    <div style={S.toolCard}>
      <div style={S.toolHeader}>
        <span style={S.toolIcon}>⌕</span>
        <span>{call.name}</span>
        <span
          style={{
            ...S.toolStatus,
            ...(call.status === 'error' ? S.toolStatusError : {}),
          }}
        >
          {call.status === 'running'
            ? 'Searching…'
            : call.status === 'error'
              ? 'Failed'
              : `${count} found`}
        </span>
      </div>
      <div style={S.toolArgs}>
        {query ? `“${query}”` : 'Recent memory'} · {windowLabel} · limit{' '}
        {call.arguments?.limit ?? 3} · evidence {call.arguments?.evidence_limit ?? 1}
      </div>
      {call.result?.error && <div style={S.toolArgs}>{call.result.error}</div>}
      {results.length > 0 && (
        <details style={S.toolDetails}>
          <summary>View retrieved memory</summary>
          {results.map((result, index) => (
            <div key={result.id ?? `${call.id}-${index}`} style={S.toolObservation}>
              {result.updated_at && (
                <div style={{ color: '#9ca3af', fontSize: 10.5 }}>
                  {new Date(result.updated_at).toLocaleString()}
                </div>
              )}
              <div>{result.text}</div>
              {result.evidence?.map((observation, evidenceIndex) => (
                <div
                  key={observation.id ?? `${call.id}-${index}-${evidenceIndex}`}
                  style={{ color: '#6b7280', marginTop: 4 }}
                >
                  Evidence: {observation.content}
                </div>
              ))}
            </div>
          ))}
        </details>
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
  const [pendingContextLabel, setPendingContextLabel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<
    'idle' | 'requesting' | VoiceRecorderStatus
  >('idle');
  const [voiceError, setVoiceError] = useState('');
  const [startingNewSession, setStartingNewSession] = useState(false);
  const [problem, setProblem] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [contentZoomFactor, setContentZoomFactor] = useState(1);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [reviewing, setReviewing] = useState<SavedConversation | null>(null);
  const [profile, setProfile] = useState<{
    scenario: string;
    aiTools: string[];
    hideAvatar: boolean;
  }>({
    scenario: 'everyday_support',
    aiTools: [],
    hideAvatar: false,
  });
  const [tutorModels, setTutorModels] = useState<TutorModelOption[]>([]);
  const [currentTutorModelId, setCurrentTutorModelId] = useState('');
  const [switchingModel, setSwitchingModel] = useState(false);
  const [sensingModel, setSensingModel] = useState<TutorModelOption>(
    blankSensingModel,
  );
  const [defaultTutorModelId, setDefaultTutorModelId] = useState('');
  const [modelCredentials, setModelCredentials] = useState<Record<string, string>>({});
  const [modelConfigLoading, setModelConfigLoading] = useState(true);
  const [modelLoadError, setModelLoadError] = useState('');
  const [modelSaveError, setModelSaveError] = useState('');
  const [modelSavedFlash, setModelSavedFlash] = useState(false);
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthView | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [cocoSleeping, setCocoSleeping] = useState(false);
  const [cocoSleepModeKnown, setCocoSleepModeKnown] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeWordStatus, setWakeWordStatus] = useState<
    WakeWordSettingsInfo['status']
  >('disabled');
  const [wakeWordDetail, setWakeWordDetail] = useState('');
  const [wakeWordCaptureError, setWakeWordCaptureError] = useState('');
  const [wakeWordSaving, setWakeWordSaving] = useState(false);
  const [connectionTests, setConnectionTests] = useState<
    Record<string, ConnectionTestStatus>
  >({});
  // Editable draft of the settings, synced from the loaded profile.
  const [editScenario, setEditScenario] = useState('everyday_support');
  const [editTools, setEditTools] = useState<string[]>([]);
  const [editHideAvatar, setEditHideAvatar] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarSaveError, setAvatarSaveError] = useState('');
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
  // Current thumbs vote per tutor message, keyed by message id. Users may
  // replace it by choosing the opposite rating.
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down'>>({});
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingHotkeyImagesRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(null);
  const pendingContextRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const problemRef = useRef('');
  const cocoSleepingRef = useRef(false);
  const voiceRecorderRef = useRef<ActiveVoiceRecorder | null>(null);
  const handleVoiceClickRef = useRef<(fromWakeWord?: boolean) => Promise<void>>(
    async () => {},
  );
  const wakeDetectionInProgressRef = useRef(false);

  useEffect(() => () => voiceRecorderRef.current?.cancel(), []);

  useEffect(() => {
    const applyZoomFactor = (value: unknown) => {
      const factor = Number(value);
      if (Number.isFinite(factor) && factor > 0) setContentZoomFactor(factor);
    };
    window.electron?.ipcRenderer
      .invoke('get-chat-content-zoom-factor')
      .then(applyZoomFactor)
      .catch(() => {});
    const cleanup = window.electron?.ipcRenderer.on(
      'chat-content-zoom-factor',
      applyZoomFactor,
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  const applyCocoSleepMode = useCallback((sleeping: boolean) => {
    cocoSleepingRef.current = sleeping;
    setCocoSleeping(sleeping);
    setCocoSleepModeKnown(true);
    if (sleeping) {
      setServiceHealth(null);
      setHealthError('');
      setHealthLoading(false);
    }
  }, []);

  const refreshServiceHealth = useCallback(async (forceModelTest = false) => {
    if (cocoSleepingRef.current) return;
    setHealthLoading(true);
    setHealthError('');
    try {
      const result = await window.electron?.ipcRenderer.invoke(
        'get-service-health',
        { forceModelTest },
      ) as ServiceHealthView | SleepingServiceHealthView | undefined;
      if (result && 'sleeping' in result && result.sleeping) {
        applyCocoSleepMode(true);
        return;
      }
      if (
        !result ||
        !('sensing' in result) ||
        !('tutor' in result) ||
        !result.sensing ||
        !result.tutor
      ) {
        throw new Error('No health response received.');
      }
      if (!cocoSleepingRef.current) setServiceHealth(result);
    } catch (error) {
      if (!cocoSleepingRef.current) {
        setHealthError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!cocoSleepingRef.current) setHealthLoading(false);
    }
  }, [applyCocoSleepMode]);

  // Keep each active conversation on disk. A short debounce avoids a write for
  // every streaming token while still preserving completed turns promptly.
  useEffect(() => {
    messagesRef.current = messages;
    problemRef.current = problem;
    if (!sessionIdRef.current || messages.length === 0) return undefined;
    const timeout = window.setTimeout(() => {
      window.electron?.ipcRenderer
        .invoke('save-chat-conversation', {
          sessionId: sessionIdRef.current,
          problem,
          messages,
        })
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [messages, problem]);

  // Rate a tutor message. Routed main → sensing /feedback → feedback.jsonl,
  // same pipeline as the bubble reactions.
  const rateMessage = (m: ChatMessage, dir: 'up' | 'down') => {
    if (!m.id || ratings[m.id] === dir) return;
    const previousRating = ratings[m.id];
    setRatings((prev) => ({ ...prev, [m.id as string]: dir }));
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
      surface: 'chat',
      message_id: m.id,
      session_id: sessionIdRef.current,
      latency_s: m.ts ? (Date.now() - m.ts) / 1000 : null,
      text: m.text,
    });
  };

  const copyMessage = async (message: ChatMessage, key: string) => {
    const text = copyableMessageText(message).trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageKey(key);
      window.setTimeout(() => {
        setCopiedMessageKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // Leave the button unchanged if the OS clipboard rejects the write.
    }
  };

  const openImagePreview = (imageDataUrl: string) => {
    window.electron?.ipcRenderer.sendMessage('open-image-preview', {
      imageDataUrl,
    });
  };

  const openImageAnnotator = (imageDataUrl: string) => {
    window.electron?.ipcRenderer.sendMessage('open-image-preview', {
      imageDataUrl,
      editable: true,
    });
  };

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, []);

  // Main relays SSE events from the tutor service. Keep one pending tutor
  // message and update it in place so text and tool activity appear in order.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('chat-stream-event', (data: any) => {
      const event = (data ?? {}) as {
        requestId?: string;
        type?: string;
        text?: string;
        call?: TutorToolCall;
        guidance?: string;
        error?: string;
        observerMetrics?: LLMCallMetrics | null;
        llm_metrics?: LLMCallMetrics | null;
        tool_calls?: TutorToolCall[];
      };
      if (!event.requestId) return;
      setMessages((current) =>
        current.map((message) => {
          if (message.requestId !== event.requestId) return message;
          if (event.type === 'text_delta') {
            return { ...message, text: message.text + (event.text ?? '') };
          }
          if (event.type === 'tool_call_started' && event.call) {
            return {
              ...message,
              toolCalls: [
                ...(message.toolCalls ?? []).filter((call) => call.id !== event.call?.id),
                event.call,
              ],
            };
          }
          if (event.type === 'tool_call_completed' && event.call) {
            return {
              ...message,
              toolCalls: (message.toolCalls ?? []).some((call) => call.id === event.call?.id)
                ? (message.toolCalls ?? []).map((call) =>
                    call.id === event.call?.id ? event.call as TutorToolCall : call,
                  )
                : [...(message.toolCalls ?? []), event.call],
            };
          }
          if (event.type === 'done') {
            return {
              ...message,
              text: event.guidance ?? message.text,
              id: message.id ?? makeMessageId(),
              ts: Date.now(),
              observerMetrics: event.observerMetrics ?? null,
              tutorMetrics: event.llm_metrics ?? null,
              toolCalls: event.tool_calls ?? message.toolCalls ?? [],
              isStreaming: false,
            };
          }
          if (event.type === 'error') {
            return {
              ...message,
              text: event.error ?? 'The tutor could not generate a response.',
              isError: true,
              isStreaming: false,
            };
          }
          return message;
        }),
      );
      if (event.type === 'done' || event.type === 'error') setSending(false);
      scrollToBottom();
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, [scrollToBottom]);

  const submitTutorRequest = useCallback(
    async (
      requestId: string,
      userText: string,
      images: string[],
      hotkeyImages: string[] = [],
    ) => {
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer.invoke('send-chat-message', {
        requestId,
        userText,
        images,
        hotkeyImages,
      });
      const r = res as {
        streamed?: boolean;
        guidance?: string;
        error?: string;
        observerMetrics?: LLMCallMetrics | null;
        tutorMetrics?: LLMCallMetrics | null;
        toolCalls?: TutorToolCall[];
      } | undefined;
      // Compatibility with older main processes and a fallback if IPC fails
      // before a stream event can be delivered.
      if (!r?.streamed && (r?.guidance !== undefined || r?.error)) {
        setMessages((current) =>
          current.map((message) =>
            message.requestId === requestId
              ? {
                  ...message,
                  text: r.error ?? r.guidance ?? '',
                  isError: Boolean(r.error),
                  isStreaming: false,
                  id: r.error ? undefined : makeMessageId(),
                  ts: r.error ? undefined : Date.now(),
                  observerMetrics: r.observerMetrics ?? null,
                  tutorMetrics: r.tutorMetrics ?? null,
                  toolCalls: r.toolCalls ?? [],
                }
              : message,
          ),
        );
        setSending(false);
      }
      scrollToBottom();
    },
    [scrollToBottom],
  );

  const submitAudioRequest = useCallback(
    async (requestId: string, audioData: string) => {
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer.invoke('send-audio-message', {
        requestId,
        audioData,
      });
      const result = res as {
        streamed?: boolean;
        error?: string;
      } | undefined;
      if (!result?.streamed && result?.error) {
        setMessages((current) =>
          current.map((message) =>
            message.requestId === requestId
              ? {
                  ...message,
                  text: result.error ?? 'The audio tutor could not respond.',
                  isError: true,
                  isStreaming: false,
                }
              : message,
          ),
        );
        setSending(false);
      }
      scrollToBottom();
    },
    [scrollToBottom],
  );

  const sendVoiceMessage = useCallback(
    async (audioData: string) => {
      const requestId = makeMessageId();
      setMessages((current) => [
        ...current,
        { role: 'user', text: '🎤 Voice message' },
        {
          role: 'tutor',
          text: '',
          requestId,
          isStreaming: true,
          toolCalls: [],
        },
      ]);
      await submitAudioRequest(requestId, audioData);
    },
    [submitAudioRequest],
  );

  // Core send: append the user turn and an empty tutor turn immediately. The
  // latter is filled by chat-stream-event updates while the IPC request runs.
  const sendMessage = useCallback(
    async (text: string, images: string[], hotkeyImages: string[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      const requestId = makeMessageId();
      const pendingContext = pendingContextRef.current;
      const userText = pendingContext
        ? `${pendingContext}\n\nThe user now says:\n${trimmed}`
        : trimmed;
      setMessages((m) => [
        ...m,
        { role: 'user', text: trimmed, images },
        {
          role: 'tutor',
          text: '',
          requestId,
          isStreaming: true,
          toolCalls: [],
          retryText: userText,
          retryImages: images,
          retryHotkeyImages: hotkeyImages,
        },
      ]);
      pendingContextRef.current = null;
      setPendingContextLabel(null);
      await submitTutorRequest(requestId, userText, images, hotkeyImages);
    },
    [submitTutorRequest],
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (sending || startingNewSession || message.retryText === undefined) return;
      const previousRequestId = message.requestId;
      const requestId = makeMessageId();
      const images = message.retryImages ?? [];
      const hotkeyImages = message.retryHotkeyImages ?? [];
      setMessages((current) =>
        current.map((item) =>
          item.requestId === previousRequestId
            ? {
                ...item,
                text: '',
                requestId,
                isError: false,
                isStreaming: true,
                toolCalls: [],
              }
            : item,
        ),
      );
      await submitTutorRequest(
        requestId,
        message.retryText,
        images,
        hotkeyImages,
      );
    },
    [sending, startingNewSession, submitTutorRequest],
  );

  // Session context from main. A new sessionId resets the conversation.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('session-init', (data: any) => {
      const { sessionId, problemStatement, tutorModelId } = (data ?? {}) as {
        sessionId?: string;
        problemStatement?: string;
        tutorModelId?: string;
      };
      if (tutorModelId) setCurrentTutorModelId(tutorModelId);
      if (sessionId && sessionId !== sessionIdRef.current) {
        if (sessionIdRef.current && messagesRef.current.length > 0) {
          window.electron?.ipcRenderer
            .invoke('save-chat-conversation', {
              sessionId: sessionIdRef.current,
              problem: problemRef.current,
              messages: messagesRef.current,
            })
            .catch(() => {});
        }
        sessionIdRef.current = sessionId;
        setMessages([]);
        setRatings({});
        setInput('');
        setPendingImages([]);
        pendingHotkeyImagesRef.current.clear();
        setSending(false);
        pendingContextRef.current = null;
        setPendingContextLabel(null);
        window.electron?.ipcRenderer
          .invoke('get-chat-conversations')
          .then((saved: unknown) => {
            if (sessionIdRef.current !== sessionId || !Array.isArray(saved)) {
              return;
            }
            const conversation = (saved as SavedConversation[]).find(
              (candidate) => candidate.sessionId === sessionId,
            );
            if (!conversation) return;
            setMessages((current) =>
              current.length === 0
                ? conversation.messages
                : [...conversation.messages, ...current],
            );
            setProblem(
              problemStatement?.trim()
                ? problemStatement
                : conversation.problem,
            );
          })
          .catch(() => {});
      }
      setProblem(problemStatement ?? '');
      setReviewing(null);
      setShowHistory(false);
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  // Load the user's onboarding profile (mode + AI tools) for the Settings panel.
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-model-configuration')
      .then((config: any) => {
        if (!config?.sensing || !Array.isArray(config.tutors) || config.tutors.length === 0) {
          const tutor = blankTutorModel();
          setTutorModels([tutor]);
          setDefaultTutorModelId(tutor.id);
          setModelLoadError(
            'No saved model configuration was found. Configure the sensing and tutor models below.',
          );
          return;
        }
        setTutorModels(config.tutors.map((model: TutorModelOption) => ({
          ...model,
          model: model.model.replace(/^(?:hosted_vllm|tinker)\//, ''),
        })));
        setSensingModel({
          ...config.sensing,
          model: String(config.sensing.model).replace(/^(?:hosted_vllm|tinker)\//, ''),
        });
        setDefaultTutorModelId(config.defaultTutorId || '');
        setCurrentTutorModelId((current) => current || config.defaultTutorId || '');
      })
      .catch((error: unknown) => {
        const tutor = blankTutorModel();
        setTutorModels([tutor]);
        setDefaultTutorModelId(tutor.id);
        setModelLoadError(
          `Could not load saved model settings: ${
            error instanceof Error ? error.message : String(error)
          }. You can configure them below.`,
        );
      })
      .finally(() => setModelConfigLoading(false));
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

  const switchTutorModel = async (modelId: string) => {
    if (!modelId || modelId === currentTutorModelId || switchingModel) return;
    setSwitchingModel(true);
    const result = await window.electron?.ipcRenderer.invoke('set-chat-model', {
      modelId,
    });
    if ((result as { success?: boolean })?.success) {
      setCurrentTutorModelId(modelId);
      if (sessionIdRef.current && messagesRef.current.length > 0) {
        window.electron?.ipcRenderer
          .invoke('save-chat-conversation', {
            sessionId: sessionIdRef.current,
            problem: problemRef.current,
            messages: messagesRef.current,
          })
          .catch(() => {});
      }
    }
    setSwitchingModel(false);
  };

  const testSettingsModelConnection = async (
    role: 'sensing' | 'tutor',
    model: TutorModelOption,
  ) => {
    const key = role === 'sensing' ? 'sensing' : model.id;
    if (!model.model.trim()) {
      setConnectionTests((current) => ({
        ...current,
        [key]: { state: 'error', message: 'Enter a model ID first.' },
      }));
      return;
    }
    setConnectionTests((current) => ({
      ...current,
      [key]: { state: 'testing', message: '' },
    }));
    try {
      const result = await window.electron?.ipcRenderer.invoke(
        'test-model-connection',
        {
          role,
          connection: {
            id: model.id,
            label: model.label || (role === 'sensing' ? 'Sensing' : 'Tutor'),
            provider: model.provider,
            model: model.model,
            baseUrl: model.baseUrl,
          },
          apiKey: modelCredentials[`${role}:${model.provider}`] ?? '',
        },
      ) as { success?: boolean; message?: string; error?: string } | undefined;
      setConnectionTests((current) => ({
        ...current,
        [key]: result?.success
          ? { state: 'success', message: result.message || 'Connected.' }
          : { state: 'error', message: result?.error || 'Connection failed.' },
      }));
    } catch (error) {
      setConnectionTests((current) => ({
        ...current,
        [key]: {
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const saveModelSettings = async () => {
    if (modelConfigLoading) return;
    setModelSaveError('');
    if (!sensingModel.model.trim()) {
      setModelSaveError('Enter a vision-capable sensing model.');
      return;
    }
    if (
      tutorModels.length === 0 ||
      tutorModels.some((model) => !model.label.trim() || !model.model.trim())
    ) {
      setModelSaveError('Add at least one tutor with a display name and model ID.');
      return;
    }
    const result = await window.electron?.ipcRenderer.invoke(
      'save-model-configuration',
      {
        sensing: sensingModel,
        tutors: tutorModels,
        defaultTutorId: defaultTutorModelId,
        credentials: modelCredentials,
      },
    );
    if (!(result as { success?: boolean })?.success) {
      setModelSaveError(
        (result as { error?: string })?.error || 'Could not save model settings.',
      );
      return;
    }
    setModelCredentials({});
    setModelLoadError('');
    setModelSavedFlash(true);
    setTimeout(() => setModelSavedFlash(false), 1500);
  };

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

  const updateAvatarVisibility = async (hideAvatar: boolean) => {
    if (avatarSaving) return;
    const previousValue = editHideAvatar;
    setEditHideAvatar(hideAvatar);
    setAvatarSaving(true);
    setAvatarSaveError('');
    try {
      const result = await window.electron?.ipcRenderer.invoke(
        'update-avatar-visibility',
        { hideAvatar },
      );
      if (!(result as { success?: boolean })?.success) {
        throw new Error(
          (result as { error?: string })?.error ||
          'Could not update desktop avatar visibility.',
        );
      }
      setProfile((current) => ({ ...current, hideAvatar }));
    } catch (error) {
      setEditHideAvatar(previousValue);
      setAvatarSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setAvatarSaving(false);
    }
  };

  const dirty =
    editScenario !== profile.scenario ||
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

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-coco-sleep-mode')
      .then((result: { sleeping?: boolean } | undefined) => {
        applyCocoSleepMode(result?.sleeping === true);
      })
      .catch(() => applyCocoSleepMode(false));
    const cleanup = window.electron?.ipcRenderer.on(
      'coco-sleep-mode-changed',
      (...args: unknown[]) => {
        const result = args[0] as { sleeping?: boolean } | undefined;
        applyCocoSleepMode(result?.sleeping === true);
      },
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, [applyCocoSleepMode]);

  useEffect(() => {
    if (!cocoSleepModeKnown || cocoSleeping) return undefined;
    void refreshServiceHealth();
    const interval = window.setInterval(() => {
      void refreshServiceHealth();
    }, 30000);
    return () => window.clearInterval(interval);
  }, [cocoSleepModeKnown, cocoSleeping, refreshServiceHealth]);

  useEffect(() => {
    const applySettings = (value: unknown) => {
      const settings = value as Partial<WakeWordSettingsInfo> | undefined;
      if (typeof settings?.enabled === 'boolean') {
        setWakeWordEnabled(settings.enabled);
      }
      if (settings?.status) setWakeWordStatus(settings.status);
      setWakeWordDetail(settings?.detail ?? '');
    };
    window.electron?.ipcRenderer
      .invoke('get-wake-word-settings')
      .then(applySettings)
      .catch(() => {});
    const removeSettingsListener = window.electron?.ipcRenderer.on(
      'wake-word-settings-changed',
      applySettings,
    );
    const removeStatusListener = window.electron?.ipcRenderer.on(
      'wake-word-status',
      (value: unknown) => {
        const status = value as Partial<WakeWordSettingsInfo> | undefined;
        if (status?.status) setWakeWordStatus(status.status);
        setWakeWordDetail(status?.detail ?? '');
      },
    );
    const removeDetectionListener = window.electron?.ipcRenderer.on(
      'wake-word-detected',
      (value: unknown) => {
        const detection = value as { id?: unknown } | undefined;
        if (typeof detection?.id === 'number') {
          window.electron?.ipcRenderer.sendMessage(
            'wake-word-detection-ack',
            { id: detection.id },
          );
        }
        if (wakeDetectionInProgressRef.current) return;
        wakeDetectionInProgressRef.current = true;
        handleVoiceClickRef.current(true).finally(() => {
          wakeDetectionInProgressRef.current = false;
        });
      },
    );
    const removeCaptureStatusListener = window.electron?.ipcRenderer.on(
      'wake-word-capture-status',
      (value: unknown) => {
        const capture = value as {
          state?: unknown;
          detail?: unknown;
        } | undefined;
        if (capture?.state === 'error') {
          setWakeWordCaptureError(
            typeof capture.detail === 'string'
              ? capture.detail
              : 'Microphone capture failed.',
          );
        } else if (capture?.state === 'active') {
          setWakeWordCaptureError('');
        }
      },
    );
    return () => {
      if (typeof removeSettingsListener === 'function') removeSettingsListener();
      if (typeof removeStatusListener === 'function') removeStatusListener();
      if (typeof removeDetectionListener === 'function') removeDetectionListener();
      if (typeof removeCaptureStatusListener === 'function') {
        removeCaptureStatusListener();
      }
    };
  }, []);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'open-chat-settings',
      () => {
        setShowHistory(false);
        setReviewing(null);
        setShowSettings(true);
      },
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  const saveMemory = async () => {
    const res = await window.electron?.ipcRenderer.invoke('save-memory', { memory: memoryDraft });
    if ((res as { success?: boolean })?.success) {
      setMemoryLoaded(memoryDraft);
      setMemoryFlash(true);
      setTimeout(() => setMemoryFlash(false), 1500);
    }
  };
  const memoryDirty = memoryDraft !== memoryLoaded;

  // Context from proactive support. Ordinary "Help me with this" requests are
  // sent immediately; "Chat about it" stages context for the next message; and
  // "Open Coco Chat" places a delegation prompt directly in the composer.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('help-request', (data: any) => {
      const {
        rawObservation,
        phrase,
        label,
        deferUntilUserMessage,
        initialInput,
      } = (data ?? {}) as {
        rawObservation?: string;
        phrase?: string;
        label?: string;
        deferUntilUserMessage?: boolean;
        initialInput?: string;
      };
      if (typeof initialInput === 'string') {
        setInput(initialInput);
        return;
      }
      const seed = (rawObservation || phrase || '').trim();
      if (seed && deferUntilUserMessage) {
        pendingContextRef.current = seed;
        setPendingContextLabel((phrase || label || 'Tutor suggestion').trim());
        return;
      }
      if (seed) sendMessage(seed, []);
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, [sendMessage]);

  // Hot-key screen capture (Cmd/Ctrl+Shift+Space) → preview thumbnail in the
  // input bar, reusing the same pending-image strip that paste drives.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('hotkey-capture', (data: any) => {
      const url = (data ?? {}).imageDataUrl as string | undefined;
      if (url) {
        pendingHotkeyImagesRef.current.add(url);
        setPendingImages((prev) => [...prev, url]);
      }
    });
    // Tell main the listener is live so it can flush any capture that arrived
    // while this window was still loading (e.g. the hot key just opened it).
    window.electron?.ipcRenderer.sendMessage('hotkey-capture-ready');
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  // The full-screen annotator sends back a flattened PNG. Replace the original
  // pending capture while retaining its hot-key provenance for the tutor.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'image-annotation-saved',
      (data: any) => {
        const original = (data ?? {}).originalImageDataUrl as string | undefined;
        const annotated = (data ?? {}).imageDataUrl as string | undefined;
        if (
          !original ||
          !annotated?.startsWith('data:image/') ||
          !pendingHotkeyImagesRef.current.has(original)
        ) {
          return;
        }
        pendingHotkeyImagesRef.current.delete(original);
        pendingHotkeyImagesRef.current.add(annotated);
        setPendingImages((current) =>
          current.map((image) => (image === original ? annotated : image)),
        );
      },
    );
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
    if (sending || startingNewSession) return;
    const imgs = pendingImages;
    const hotkeyImgs = imgs.filter((src) =>
      pendingHotkeyImagesRef.current.has(src),
    );
    const clearSentHotkeyImages = () => {
      hotkeyImgs.forEach((src) => pendingHotkeyImagesRef.current.delete(src));
    };
    const text = input;
    setInput('');
    setPendingImages([]);
    if (reviewing) {
      const conversation = reviewing;
      setSending(true);
      window.electron?.ipcRenderer
        .invoke('resume-chat-conversation', {
          sessionId: conversation.sessionId,
        })
        .then((result: any) => {
          if (!result?.success) {
            setInput(text);
            setPendingImages(imgs);
            setSending(false);
            return;
          }
          sessionIdRef.current = conversation.sessionId;
          setProblem(conversation.problem);
          setMessages(conversation.messages);
          setCurrentTutorModelId(
            result.tutorModelId || conversation.tutorModelId || currentTutorModelId,
          );
          setRatings({});
          setReviewing(null);
          setShowHistory(false);
          setSending(false);
          sendMessage(text, imgs, hotkeyImgs);
          clearSentHotkeyImages();
        })
        .catch(() => {
          setInput(text);
          setPendingImages(imgs);
          setSending(false);
        });
      return;
    }
    sendMessage(text, imgs, hotkeyImgs);
    clearSentHotkeyImages();
  };

  const handleVoiceClick = async (fromWakeWord = false) => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.stop();
      return;
    }
    if (fromWakeWord) {
      setShowSettings(false);
      setShowHistory(false);
      setReviewing(null);
    }
    const unavailable =
      sending ||
      startingNewSession ||
      (!fromWakeWord && reviewing) ||
      voiceState === 'requesting';
    if (unavailable) {
      if (fromWakeWord) {
        await window.electron?.ipcRenderer.invoke(
          'set-wake-word-capture-paused',
          { paused: false },
        );
      }
      return;
    }
    await window.electron?.ipcRenderer.invoke(
      'set-wake-word-capture-paused',
      { paused: true },
    );
    setVoiceError('');
    setVoiceState('requesting');
    let audioData: string | null = null;
    try {
      const recorder = await startVoiceRecorder({
        silenceMs: 2_500,
        maxDurationMs: 30_000,
        onStatus: setVoiceState,
      });
      voiceRecorderRef.current = recorder;
      const recording = await recorder.done;
      audioData = recording.wavBase64;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'Voice recording cancelled.') setVoiceError(message);
    } finally {
      voiceRecorderRef.current = null;
      setVoiceState('idle');
      await window.electron?.ipcRenderer.invoke(
        'set-wake-word-capture-paused',
        { paused: false },
      );
    }
    if (audioData) await sendVoiceMessage(audioData);
  };
  handleVoiceClickRef.current = handleVoiceClick;

  const updateWakeWordEnabled = async (enabled: boolean) => {
    if (wakeWordSaving) return;
    setWakeWordSaving(true);
    setWakeWordCaptureError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'set-wake-word-settings',
        { enabled },
      )) as ({ success?: boolean; error?: string } &
        Partial<WakeWordSettingsInfo>) | undefined;
      if (!result?.success) {
        throw new Error(result?.error ?? 'Could not update voice activation.');
      }
      setWakeWordEnabled(enabled);
      if (result.status) setWakeWordStatus(result.status);
    } catch (error) {
      setWakeWordCaptureError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWakeWordSaving(false);
    }
  };

  const handleNewSession = async () => {
    if (sending || startingNewSession) return;
    setStartingNewSession(true);
    try {
      await window.electron?.ipcRenderer.invoke('start-new-chat-session', {
        problemStatement: problem,
      });
    } finally {
      setStartingNewSession(false);
    }
  };

  const openHistory = async () => {
    setShowSettings(false);
    setReviewing(null);
    setShowHistory(true);
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const saved = await window.electron?.ipcRenderer.invoke(
        'get-chat-conversations',
      );
      setConversations(
        (Array.isArray(saved) ? saved : []).filter(
          (conversation: SavedConversation) =>
            conversation.sessionId !== sessionIdRef.current,
        ),
      );
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  };

  const conversationTitle = (conversation: SavedConversation) =>
    conversation.title || conversation.problem || 'General help session';

  const conversationPreview = (conversation: SavedConversation) =>
    conversation.messages.find((message) => message.text.trim())?.text ||
    'No messages';

  const formatConversationDate = (timestamp: number) =>
    new Date(timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend =
    !sending &&
    !startingNewSession &&
    voiceState === 'idle' &&
    (input.trim().length > 0 || pendingImages.length > 0);
  const voiceActive = voiceState === 'listening' || voiceState === 'speaking';
  let voiceStatusText = '';
  if (voiceState === 'requesting') {
    voiceStatusText = 'Requesting microphone access…';
  } else if (voiceState === 'speaking') {
    voiceStatusText = 'Listening… Coco will send after you stop speaking.';
  } else if (voiceState === 'listening') {
    voiceStatusText = 'Listening… start speaking, or press stop to send.';
  }
  const visibleMessages = reviewing?.messages ?? messages;
  const hasRunningTool = visibleMessages.some(
    (message) =>
      message.role === 'tutor' &&
      message.toolCalls?.some((call) => call.status === 'running'),
  );
  const selectedTutorModel = tutorModels.find(
    (model) => model.id === currentTutorModelId,
  );
  const selectedTutorProvider = MODEL_PROVIDER_OPTIONS.find(
    ([id]) => id === selectedTutorModel?.provider,
  )?.[1] ?? selectedTutorModel?.provider;
  const selectedTutorTooltip = selectedTutorModel
    ? [
        selectedTutorModel.label,
        `Provider: ${selectedTutorProvider}`,
        `Model: ${selectedTutorModel.model}`,
        ...(selectedTutorModel.baseUrl
          ? [`Endpoint: ${selectedTutorModel.baseUrl}`]
          : []),
      ].join('\n')
    : 'Tutor model for this conversation';
  const sensingUnavailable = serviceHealth?.sensing.connected === false;
  const tutorUnavailable = serviceHealth?.tutor.connected === false;
  const serviceUnavailable = sensingUnavailable || tutorUnavailable;
  const modelUnavailable = Boolean(serviceHealth && [
    serviceHealth.sensing,
    serviceHealth.tutor,
  ].some((health) => health.modelAssessment?.status === 'failed'));
  const modelsVerified = Boolean(serviceHealth && [
    serviceHealth.sensing,
    serviceHealth.tutor,
  ].every((health) => health.modelAssessment?.status === 'verified'));
  const modelConfigurationIssue = Boolean(serviceHealth && [
    serviceHealth.sensing,
    serviceHealth.tutor,
  ].some((health) =>
    health.modelAssessment?.status === 'legacy_unassessed' ||
    health.modelAssessment?.status === 'not_configured'));
  const chatHealthLabel = cocoSleeping
    ? 'Sleeping'
    : serviceUnavailable
      ? 'Service issue'
      : modelUnavailable
        ? 'Model issue'
        : modelConfigurationIssue
          ? 'Configure models'
          : serviceHealth
            ? (modelsVerified ? 'Connected' : 'Services reachable')
            : healthLoading
              ? 'Checking health…'
              : 'Health unknown';
  const chatHealthColor = cocoSleeping
    ? '#6b7280'
    : serviceUnavailable || modelUnavailable
      ? '#dc2626'
      : modelConfigurationIssue
        ? '#b45309'
        : modelsVerified
          ? '#16a34a'
          : '#6b7280';
  const chatHealthTitle = cocoSleeping
    ? 'Coco is asleep. Service health checks are paused until Coco wakes.'
    : serviceUnavailable
      ? [
          sensingUnavailable ? 'Sensing server is not reachable.' : '',
          tutorUnavailable ? 'Tutor agent is not reachable.' : '',
          'Click to open Settings.',
        ].filter(Boolean).join(' ')
      : modelUnavailable
        ? [
            serviceHealth?.sensing.modelAssessment?.status === 'failed'
              ? `Sensing model: ${serviceHealth.sensing.modelAssessment.detail}`
              : '',
            serviceHealth?.tutor.modelAssessment?.status === 'failed'
              ? `Tutor model: ${serviceHealth.tutor.modelAssessment.detail}`
              : '',
            'Click to open Settings.',
          ].filter(Boolean).join(' ')
        : modelConfigurationIssue
          ? 'A saved model configuration is required. Click to open Settings.'
          : serviceHealth
            ? 'Local services and configured models passed their connection tests.'
            : 'Checking local service health.';
  const hasChatHealthIssue =
    !cocoSleeping &&
    (serviceUnavailable || modelUnavailable || modelConfigurationIssue);

  return (
    <div style={S.root}>
      <div
        role="banner"
        style={S.header}
      >
        <span style={S.brand}>
          <span
            role="status"
            aria-label={chatHealthLabel}
            style={{ ...S.statusDot, background: chatHealthColor }}
            title={chatHealthTitle}
          />
          Coco
          {hasChatHealthIssue ? (
            <button
              type="button"
              style={{ ...S.healthHeaderButton, color: chatHealthColor }}
              title={chatHealthTitle}
              aria-label={`${chatHealthLabel}. Open Settings`}
              onClick={() => {
                setShowHistory(false);
                setReviewing(null);
                setShowSettings(true);
              }}
            >
              · {chatHealthLabel}
            </button>
          ) : (
            <span style={S.sub} title={chatHealthTitle}>
              · {chatHealthLabel}
            </span>
          )}
        </span>
        <div style={S.headerBtns}>
          <button
            type="button"
            style={{
              ...S.newSessionBtn,
              ...(sending || startingNewSession ? S.sendBtnDisabled : {}),
            }}
            title="Start a new session"
            aria-label="Start a new session"
            disabled={sending || startingNewSession}
            onClick={handleNewSession}
          >
            {startingNewSession ? 'Starting…' : '+ New'}
          </button>
          <button
            type="button"
            style={{ ...S.iconBtn, ...(showHistory ? S.iconBtnActive : {}) }}
            title="Review past conversations"
            aria-label="Review past conversations"
            onClick={openHistory}
          >
            ◷
          </button>
          <button
            type="button"
            style={{ ...S.iconBtn, ...(showSettings ? S.iconBtnActive : {}) }}
            title="Settings"
            onClick={() => {
              setShowHistory(false);
              setReviewing(null);
              setShowSettings((v) => !v);
            }}
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

      <div style={S.contentViewport}>
        <div
          data-testid="chat-scalable-content"
          style={{
            ...S.scalableContent,
            transform: `scale(${contentZoomFactor})`,
            width: `${100 / contentZoomFactor}%`,
            height: `${100 / contentZoomFactor}%`,
          }}
        >

      {showSettings && (
        <div style={S.settings}>
          <div style={S.groupLabel}>Health</div>
          <div style={S.helpText}>
            {cocoSleeping
              ? 'Coco is asleep. Service health checks are paused until Coco wakes.'
              : "Checks Coco's local services and sends short real requests to the configured models. The sensing test includes a small test image."}
          </div>
          {cocoSleeping && (
            <div role="status" style={S.healthDetail}>
              Sleeping intentionally stops the sensing server and tutor agent.
            </div>
          )}
          {!cocoSleeping && (
            <div style={S.healthList}>
            {([
              ['sensing', 'Sensing server', serviceHealth?.sensing],
              ['tutor', 'Tutor agent', serviceHealth?.tutor],
            ] as const).map(([key, label, health]) => {
              const serviceStatusLabel = health
                ? `${health.connected ? 'Connected' : 'Not connected'} (service)`
                : `${healthLoading ? 'Checking…' : 'Not checked'} (service)`;
              const modelAssessment = health?.modelAssessment;
              const modelStatusLabel = modelAssessment
                ? modelAssessment.status === 'verified'
                  ? 'Connected (model)'
                  : modelAssessment.status === 'failed'
                    ? 'Not connected (model)'
                    : modelAssessment.status === 'not_configured'
                      ? 'Not configured (model)'
                      : 'Not assessed (model)'
                : `${healthLoading ? 'Checking…' : 'Not checked'} (model)`;
              const modelDetail = modelAssessment?.detail
                ?.replace(/^Connected\s*[—-]\s*/i, '')
                .replace(/^Connected\.?$/i, '');
              const details = [
                serviceStatusLabel,
                health?.detail,
                `${modelStatusLabel}${modelDetail ? ` — ${modelDetail}` : ''}`,
              ].filter(Boolean);
              const hasHealthIssue = Boolean(
                health && (
                  !health.connected || modelAssessment?.status === 'failed'
                ),
              );
              const isFullyConnected = Boolean(
                health?.connected && modelAssessment?.status === 'verified',
              );
              return (
                <div
                  key={key}
                  style={S.healthRow}
                  aria-label={`${label}: ${serviceStatusLabel}; ${modelStatusLabel}`}
                >
                  <span
                    style={{
                      ...S.healthDot,
                      background: health
                        ? (hasHealthIssue
                          ? '#ef4444'
                          : isFullyConnected
                            ? '#22c55e'
                            : '#f59e0b')
                        : '#d1d5db',
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={S.healthName}>{label}</div>
                    <div style={{
                      ...S.healthDetail,
                      color: hasHealthIssue
                        ? '#dc2626'
                        : isFullyConnected
                          ? '#16a34a'
                          : health
                            ? '#b45309'
                            : undefined,
                    }}>
                      {details.join(' · ')}
                    </div>
                  </div>
                </div>
              );
            })}
            </div>
          )}
          {!cocoSleeping && (
            <div style={S.healthActions}>
            <button
              type="button"
              style={{ ...S.addBtn, ...(healthLoading ? S.sendBtnDisabled : {}) }}
              disabled={healthLoading}
              onClick={() => void refreshServiceHealth(true)}
            >
              {healthLoading ? 'Checking…' : 'Check again'}
            </button>
            {serviceHealth && !healthLoading && (
              <span style={S.healthDetail}>
                Checked {new Date(serviceHealth.checkedAt).toLocaleTimeString()}
              </span>
            )}
            </div>
          )}
          {!cocoSleeping && healthError && (
            <div style={{ color: '#b91c1c', fontSize: 11.5, marginBottom: 12 }}>
              Health check failed: {healthError}
            </div>
          )}
          <div style={S.sectionDivider} />

          <div style={S.groupLabel}>Voice activation</div>
          <label
            style={{
              ...S.healthRow,
              alignItems: 'center',
              cursor: wakeWordSaving ? 'default' : 'pointer',
              marginBottom: 7,
            }}
          >
            <input
              type="checkbox"
              checked={wakeWordEnabled}
              disabled={wakeWordSaving}
              onChange={(event) =>
                updateWakeWordEnabled(event.target.checked)
              }
            />
            <span>
              <span style={S.healthName}>Listen for Coco</span>
              <span style={{ ...S.healthDetail, display: 'block' }}>
                Detects “Coco”, “Hi Coco”, and “Hey Coco”.
              </span>
            </span>
          </label>
          <div style={S.helpText}>
            Audio is analyzed continuously by a small local model and discarded.
            Coco pauses listening while asleep and while recording a voice message.
          </div>
          {wakeWordEnabled && (
            <div
              role="status"
              style={{
                ...S.healthDetail,
                marginTop: 6,
                color:
                  wakeWordCaptureError || wakeWordStatus === 'error'
                    ? '#b91c1c'
                    : '#16a34a',
              }}
            >
              {wakeWordCaptureError
                ? `Microphone unavailable: ${wakeWordCaptureError}`
                : wakeWordStatus === 'error'
                  ? wakeWordDetail || 'The local wake-word model could not start.'
                  : cocoSleeping || wakeWordStatus === 'sleeping'
                    ? 'Paused while Coco is asleep.'
                    : wakeWordStatus === 'starting'
                      ? 'Starting the local detector…'
                      : 'Listening locally.'}
            </div>
          )}
          <div style={S.sectionDivider} />

          <div style={S.groupLabel}>Models &amp; providers</div>
          <div style={S.helpText}>
            The sensing model receives screenshots. Saving changes restarts the local sensing and tutor services.
          </div>
          {modelConfigLoading && (
            <div style={{ ...S.helpText, marginTop: 8 }}>Loading model settings…</div>
          )}
          {modelLoadError && (
            <div style={{ color: '#b45309', fontSize: 11.5, margin: '8px 0' }}>
              {modelLoadError}
            </div>
          )}
              <div style={S.customForm}>
                <select
                  style={S.customInput}
                  value={sensingModel.provider}
                  onChange={(event) => setSensingModel({
                    ...sensingModel,
                    provider: event.target.value,
                  })}
                >
                  {MODEL_PROVIDER_OPTIONS.map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
                <input
                  style={S.customInput}
                  value={sensingModel.model}
                  placeholder={sensingModel.provider === 'hosted_vllm'
                    ? 'Exact model ID returned by /v1/models'
                    : 'Vision-capable sensing model'}
                  onChange={(event) => setSensingModel({
                    ...sensingModel,
                    model: event.target.value,
                  })}
                />
                {MODEL_ENDPOINT_PROVIDERS.has(sensingModel.provider) && (
                  <input
                    style={S.customInput}
                    value={sensingModel.baseUrl ?? ''}
                    placeholder={sensingModel.provider === 'hosted_vllm'
                      ? 'OpenAI-compatible base URL, ending in /v1'
                      : 'LM Studio host'}
                    onChange={(event) => setSensingModel({
                      ...sensingModel,
                      baseUrl: event.target.value,
                    })}
                  />
                )}
                {sensingModel.provider !== 'lm_studio' && (
                  <input
                    style={S.customInput}
                    type="password"
                    value={modelCredentials[`sensing:${sensingModel.provider}`] ?? ''}
                    placeholder={sensingModel.provider === 'hosted_vllm'
                      ? 'Endpoint API key (optional; blank keeps the saved key)'
                      : 'Replace sensing API key (leave blank to keep it)'}
                    onChange={(event) => setModelCredentials((current) => ({
                      ...current,
                      [`sensing:${sensingModel.provider}`]: event.target.value,
                    }))}
                  />
                )}
                <div style={S.connectionTestRow}>
                  <button
                    type="button"
                    style={{
                      ...S.connectionTestButton,
                      ...(connectionTests.sensing?.state === 'testing'
                        ? S.sendBtnDisabled
                        : {}),
                    }}
                    aria-label="Test sensing model connection"
                    disabled={connectionTests.sensing?.state === 'testing'}
                    onClick={() => void testSettingsModelConnection(
                      'sensing',
                      sensingModel,
                    )}
                  >
                    {connectionTests.sensing?.state === 'testing'
                      ? 'Testing…'
                      : 'Test connection'}
                  </button>
                  {connectionTests.sensing?.state === 'success' && (
                    <span style={S.connectionTestSuccess}>
                      {connectionTests.sensing.message}
                    </span>
                  )}
                  {connectionTests.sensing?.state === 'error' && (
                    <details style={S.connectionTestError}>
                      <summary>Connection failed — show details</summary>
                      <pre style={S.connectionTestErrorText}>
                        {connectionTests.sensing.message}
                      </pre>
                    </details>
                  )}
                </div>
              </div>

              <div style={S.helpText}>
                Tutor models answer in chat. Configure multiple models, choose
                a default, and switch between them anytime.
              </div>
              {tutorModels.map((model, index) => (
                <div key={model.id} style={S.customForm}>
                  <input
                    style={S.customInput}
                    value={model.label}
                    placeholder="Display name"
                    onChange={(event) => setTutorModels((current) =>
                      current.map((item, i) => i === index
                        ? { ...item, label: event.target.value }
                        : item))}
                  />
                  <select
                    style={S.customInput}
                    value={model.provider}
                    onChange={(event) => setTutorModels((current) =>
                      current.map((item, i) => i === index
                        ? { ...item, provider: event.target.value }
                        : item))}
                  >
                    {MODEL_PROVIDER_OPTIONS.map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                  <input
                    style={S.customInput}
                    value={model.model}
                    placeholder={model.provider === 'hosted_vllm'
                      ? 'Exact model ID returned by /v1/models'
                      : 'Tutor model ID'}
                    onChange={(event) => setTutorModels((current) =>
                      current.map((item, i) => i === index
                        ? { ...item, model: event.target.value }
                        : item))}
                  />
                  {MODEL_ENDPOINT_PROVIDERS.has(model.provider) && (
                    <input
                      style={S.customInput}
                      value={model.baseUrl ?? ''}
                      placeholder={model.provider === 'hosted_vllm'
                        ? 'OpenAI-compatible base URL, ending in /v1'
                        : 'LM Studio host'}
                      onChange={(event) => setTutorModels((current) =>
                        current.map((item, i) => i === index
                          ? { ...item, baseUrl: event.target.value }
                          : item))}
                    />
                  )}
                  {model.provider !== 'lm_studio' && (
                    <input
                      style={S.customInput}
                      type="password"
                      value={modelCredentials[`tutor:${model.provider}`] ?? ''}
                      placeholder={model.provider === 'hosted_vllm'
                        ? 'Endpoint API key (optional; blank keeps the saved key)'
                        : 'Replace tutor API key (leave blank to keep it)'}
                      onChange={(event) => setModelCredentials((current) => ({
                        ...current,
                        [`tutor:${model.provider}`]: event.target.value,
                      }))}
                    />
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                    <label>
                      <input
                        type="radio"
                        checked={defaultTutorModelId === model.id}
                        onChange={() => setDefaultTutorModelId(model.id)}
                      />{' '}Default
                    </label>
                    {tutorModels.length > 1 && (
                      <button
                        type="button"
                        style={{ border: 'none', background: 'none', color: '#b91c1c', cursor: 'pointer' }}
                        onClick={() => {
                          const next = tutorModels.filter((item) => item.id !== model.id);
                          setTutorModels(next);
                          if (defaultTutorModelId === model.id) setDefaultTutorModelId(next[0].id);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div style={S.connectionTestRow}>
                    <button
                      type="button"
                      style={{
                        ...S.connectionTestButton,
                        ...(connectionTests[model.id]?.state === 'testing'
                          ? S.sendBtnDisabled
                          : {}),
                      }}
                      aria-label={`Test ${model.label || 'tutor model'} connection`}
                      disabled={connectionTests[model.id]?.state === 'testing'}
                      onClick={() => void testSettingsModelConnection('tutor', model)}
                    >
                      {connectionTests[model.id]?.state === 'testing'
                        ? 'Testing…'
                        : 'Test connection'}
                    </button>
                    {connectionTests[model.id]?.state === 'success' && (
                      <span style={S.connectionTestSuccess}>
                        {connectionTests[model.id].message}
                      </span>
                    )}
                    {connectionTests[model.id]?.state === 'error' && (
                      <details style={S.connectionTestError}>
                        <summary>Connection failed — show details</summary>
                        <pre style={S.connectionTestErrorText}>
                          {connectionTests[model.id].message}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                style={{ ...S.addBtn, marginBottom: 12 }}
                onClick={() => {
                  const id = `tutor-${Date.now()}`;
                  setTutorModels((current) => [
                    ...current,
                    { id, label: '', provider: 'anthropic', model: '' },
                  ]);
                }}
              >
                + Add tutor model
              </button>
              <div style={{ ...S.saveRow, marginBottom: 14 }}>
                <button
                  type="button"
                  style={S.saveBtn}
                  disabled={modelConfigLoading}
                  onClick={saveModelSettings}
                >
                  Save model settings
                </button>
                {modelSavedFlash && <span style={S.saved}>✓ Saved</span>}
              </div>
              {modelSaveError && (
                <div style={{ color: '#b91c1c', fontSize: 11.5, marginBottom: 12 }}>
                  {modelSaveError}
                </div>
              )}
              <div style={S.sectionDivider} />
          <div style={S.groupLabel}>Desktop</div>
          <label style={S.toggleRow} htmlFor="hide-desktop-avatar">
            <input
              id="hide-desktop-avatar"
              type="checkbox"
              checked={editHideAvatar}
              disabled={avatarSaving}
              onChange={(e) => void updateAvatarVisibility(e.target.checked)}
            />
            <span>
              <strong style={S.toggleTitle}>Hide desktop avatar</strong>
              <span style={S.toggleHelp}>
                Keep Coco in the system tray and show proactive suggestions as
                notifications.
              </span>
            </span>
          </label>
          {avatarSaving && (
            <div style={{ ...S.helpText, marginTop: -8 }}>Applying…</div>
          )}
          {avatarSaveError && (
            <div style={{ color: '#b91c1c', fontSize: 11.5, margin: '-8px 0 12px' }}>
              {avatarSaveError}
            </div>
          )}

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

      {(!showHistory || reviewing) && (reviewing?.problem || problem) && (
        <div style={S.problem}>Task: {reviewing?.problem || problem}</div>
      )}

      {showHistory && !reviewing ? (
        <div style={S.historyPanel}>
          <div style={S.historyPanelHeader}>
            <span style={S.historyTitle}>Past conversations</span>
            <button
              type="button"
              style={{ ...S.historyBack, marginLeft: 'auto' }}
              onClick={() => setShowHistory(false)}
            >
              Back to chat
            </button>
          </div>
          <div style={S.historyList}>
            {historyLoading && (
              <div style={S.empty}>Loading conversations…</div>
            )}
            {!historyLoading && historyError && (
              <div style={S.empty}>
                Conversation history could not be loaded.
              </div>
            )}
            {!historyLoading && !historyError && conversations.length === 0 && (
              <div style={S.empty}>
                Your past conversations will appear here.
              </div>
            )}
            {!historyLoading &&
              conversations.map((conversation) => (
                <button
                  key={conversation.sessionId}
                  type="button"
                  style={S.historyItem}
                  onClick={() => setReviewing(conversation)}
                >
                  <span style={S.historyItemTitle}>
                    {conversationTitle(conversation)}
                  </span>
                  <span style={S.historyItemMeta}>
                    {formatConversationDate(conversation.updatedAt)}
                    {' · '}
                    {conversation.messages.length}{' '}
                    {conversation.messages.length === 1
                      ? 'message'
                      : 'messages'}
                  </span>
                  <span style={S.historyItemPreview}>
                    {conversationPreview(conversation)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      ) : (
        <>
          {reviewing && (
            <div style={S.reviewBanner}>
              <span>Viewing a past conversation</span>
              <button
                type="button"
                style={{ ...S.historyBack, marginLeft: 'auto' }}
                onClick={() => setReviewing(null)}
              >
                Back to history
              </button>
            </div>
          )}
          <div style={S.list} ref={listRef}>
        {visibleMessages.length === 0 && !sending && (
          <div style={S.empty}>
            Ask Coco about your task, an AI tool, or anything else.
            <br />
            You can paste a screenshot to show what you&apos;re working on.
          </div>
        )}
        {visibleMessages.map((m, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={m.role === 'user' ? S.userRow : S.tutorRow}>
            {m.role === 'user' ? (
              <>
                <div style={S.userBubble}>
                  {m.text}
                  {m.images && m.images.length > 0 && (
                    <div style={S.thumbRow}>
                      {m.images.map((src, j) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <button
                          key={j}
                          type="button"
                          style={S.imagePreviewButton}
                          aria-label={`Preview message attachment ${j + 1}`}
                          title="Preview attachment"
                          onClick={() => openImagePreview(src)}
                        >
                          <img src={src} alt={`Attachment ${j + 1}`} style={S.thumb} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {m.text.trim() && (
                  <div style={S.userMessageActions}>
                    <button
                      type="button"
                      style={{
                        ...S.copyMessageBtn,
                        ...(copiedMessageKey === messageCopyKey(m, i)
                          ? S.copyMessageBtnDone
                          : {}),
                      }}
                      aria-label="Copy user message"
                      title="Copy message"
                      onClick={() => void copyMessage(m, messageCopyKey(m, i))}
                    >
                      {copiedMessageKey === messageCopyKey(m, i) ? 'Copied ✓' : 'Copy'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={S.tutorAvatar}>C</div>
                <div>
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div style={S.toolStack}>
                      {m.toolCalls.map((call) => (
                        <ToolCallCard key={call.id} call={call} />
                      ))}
                    </div>
                  )}
                  {(m.text || m.isError) && (
                    <div style={m.isError ? S.errBubble : S.tutorBubble}>
                      {m.isError ? (
                        <>
                          <div>{m.text}</div>
                          {m.retryText !== undefined && (
                            <button
                              type="button"
                              style={{
                                ...S.retryBtn,
                                ...(sending || startingNewSession ? S.sendBtnDisabled : {}),
                              }}
                              disabled={sending || startingNewSession}
                              onClick={() => retryMessage(m)}
                            >
                              Retry
                            </button>
                          )}
                        </>
                      ) : <TutorMessage text={m.text} />}
                    </div>
                  )}
                  {!m.isError && (
                    <ChatMetrics
                      observerMetrics={m.observerMetrics}
                      tutorMetrics={m.tutorMetrics}
                    />
                  )}
                  {(m.text.trim() || (!m.isError && m.id)) && (
                    <div style={S.feedbackRow}>
                      {m.text.trim() && (
                        <button
                          type="button"
                          style={{
                            ...S.copyMessageBtn,
                            ...(copiedMessageKey === messageCopyKey(m, i)
                              ? S.copyMessageBtnDone
                              : {}),
                          }}
                          aria-label="Copy tutor message"
                          title="Copy message"
                          onClick={() => void copyMessage(m, messageCopyKey(m, i))}
                        >
                          {copiedMessageKey === messageCopyKey(m, i) ? 'Copied ✓' : 'Copy'}
                        </button>
                      )}
                      {!m.isError && m.id && (['up', 'down'] as const).map((dir) => (
                          <button
                            key={dir}
                            type="button"
                            aria-label={dir === 'up' ? 'Helpful' : 'Not helpful'}
                            title={dir === 'up' ? 'Helpful' : 'Not helpful'}
                            disabled={ratings[m.id as string] === dir}
                            style={{
                              ...S.feedbackBtn,
                              ...(ratings[m.id as string] === dir
                                ? S.feedbackBtnRated
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
        {sending && !hasRunningTool && (
          <div style={S.typing}>Coco is thinking…</div>
        )}
      </div>

      <div style={S.composer}>
        {pendingContextLabel && (
          <div style={S.pendingContext}>
            <span style={S.pendingContextText}>
              Suggestion context attached: {pendingContextLabel}
            </span>
            <button
              type="button"
              style={S.pendingContextX}
              aria-label="Remove suggestion context"
              title="Remove suggestion context"
              onClick={() => {
                pendingContextRef.current = null;
                setPendingContextLabel(null);
              }}
            >
              ×
            </button>
          </div>
        )}
        {pendingImages.length > 0 && (
          <div style={S.pending}>
            {pendingImages.map((src, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} style={S.pendingThumbWrap}>
                <button
                  type="button"
                  style={S.imagePreviewButton}
                  aria-label={`Preview attached image ${i + 1}`}
                  title="Preview image"
                  onClick={() => openImagePreview(src)}
                >
                  <img src={src} alt={`Attachment ${i + 1}`} style={S.thumb} />
                </button>
                {pendingHotkeyImagesRef.current.has(src) && (
                  <button
                    type="button"
                    style={S.pendingAnnotate}
                    aria-label={`Annotate hotkey screenshot ${i + 1}`}
                    title="Annotate screenshot"
                    onClick={() => openImageAnnotator(src)}
                  >
                    ✎ Edit
                  </button>
                )}
                <button
                  type="button"
                  style={S.pendingX}
                  aria-label={`Remove attached image ${i + 1}`}
                  title="Remove image"
                  onClick={() => {
                    pendingHotkeyImagesRef.current.delete(src);
                    setPendingImages((prev) => prev.filter((_, j) => j !== i));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {tutorModels.length > 0 && (
          <div style={S.composerModelRow} data-testid="composer-model-selector">
            <span style={S.composerModelLabel}>Tutor model</span>
            <select
              style={S.modelSelect}
              aria-label="Tutor model"
              title={selectedTutorTooltip}
              value={currentTutorModelId}
              disabled={switchingModel || sending || voiceState !== 'idle'}
              onChange={(event) => switchTutorModel(event.target.value)}
            >
              {tutorModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </div>
        )}
        <div style={S.inputRow}>
          <textarea
            style={S.textarea}
            rows={2}
            placeholder={
              voiceState === 'idle'
                ? 'Ask the tutor… (paste an image to attach)'
                : 'Listening to your voice…'
            }
            value={input}
            disabled={voiceState !== 'idle'}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            aria-label={
              voiceActive ? 'Stop voice recording' : 'Start voice recording'
            }
            title={
              voiceActive ? 'Stop and send voice message' : 'Talk to Coco'
            }
            style={{
              ...S.micBtn,
              ...(voiceActive ? S.micBtnActive : {}),
              ...(sending || startingNewSession || reviewing || voiceState === 'requesting'
                ? S.sendBtnDisabled
                : {}),
            }}
            disabled={
              sending ||
              startingNewSession ||
              Boolean(reviewing) ||
              voiceState === 'requesting'
            }
            onClick={() => handleVoiceClick()}
          >
            {voiceActive ? (
              <svg
                aria-hidden="true"
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="currentColor"
              >
                <rect x="2" y="2" width="9" height="9" rx="1.5" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5" />
                <path d="M12 18.5V22" />
                <path d="M9 22h6" />
              </svg>
            )}
          </button>
          <button
            type="button"
            style={{ ...S.sendBtn, ...(canSend ? {} : S.sendBtnDisabled) }}
            onClick={handleSend}
            disabled={!canSend}
          >
            Send
          </button>
        </div>
        {voiceState !== 'idle' && (
          <div style={S.voiceHint}>{voiceStatusText}</div>
        )}
        {voiceState === 'idle' && voiceError && (
          <div style={S.voiceError}>{voiceError}</div>
        )}
        {voiceState === 'idle' && !voiceError && (
          <div style={S.hotkeyHint}>
            Press <span style={S.hotkeyKbd}>{HOTKEY_LABEL}</span> anytime to grab a screenshot
          </div>
        )}
      </div>
        </>
      )}
        </div>
      </div>
    </div>
  );
}
