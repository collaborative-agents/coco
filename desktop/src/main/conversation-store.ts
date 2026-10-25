/**
 * Local, cross-session storage for conversations shown in the chat panel.
 *
 * The renderer sends a complete snapshot after a conversation changes. Keeping
 * one JSON record per conversation makes history reads simple and lets a crash
 * leave, at worst, the previous complete snapshot intact.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import { parseChatSuggestion } from '../shared/chat-suggestion';
import type { ChatSuggestion } from '../shared/chat-suggestion';
import { parseAgentActivity } from '../shared/agent-execution';
import type { AgentActivity } from '../shared/agent-execution';
import type { LLMCallMetrics } from '../renderer/components/observation-types';

export interface StoredChatMessage {
  tutorMetrics?: LLMCallMetrics | null;
  observerMetrics?: LLMCallMetrics | null;
  activity?: AgentActivity[];
  stopped?: boolean;
  role: 'user' | 'tutor';
  text: string;
  images?: string[];
  isError?: boolean;
  id?: string;
  ts?: number;
  /** Set when this tutor message is a proactive suggestion. */
  suggestion?: ChatSuggestion;
  folded?: boolean;
  /** Correlates a tutor reply with the request main is still streaming. */
  requestId?: string;
  /** Set while the reply is in flight; main settles it if the chat is gone. */
  isStreaming?: boolean;
  /** Request text retained on unfinished or failed replies so they can retry. */
  retryText?: string;
  retryRequestKind?: 'chat' | 'practice_suggestions';
}

export type StoredReply = Pick<
  StoredChatMessage,
  'text' | 'isError' | 'tutorMetrics' | 'observerMetrics' | 'activity' | 'stopped'
>;

/** Keep measured usage, including zero; reject malformed snapshot values. */
function parseMetrics(value: unknown): LLMCallMetrics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const metrics: Record<string, unknown> = {};
  for (const key of [
    'prompt_tokens',
    'completion_tokens',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'duration_ms',
    'started_at',
    'ended_at',
  ]) {
    if (
      typeof source[key] === 'number' &&
      Number.isFinite(source[key]) &&
      source[key] >= 0
    )
      metrics[key] = source[key];
  }
  for (const key of ['call_id', 'operation', 'model', 'provider', 'error']) {
    if (typeof source[key] === 'string') metrics[key] = source[key];
  }
  if (typeof source.success === 'boolean') metrics.success = source.success;
  if (source.modality === 'llm' || source.modality === 'vlm')
    metrics.modality = source.modality;
  return Object.keys(metrics).length ? (metrics as LLMCallMetrics) : undefined;
}

export const INTERRUPTED_REPLY_TEXT =
  "Coco's reply was interrupted before it finished. Please retry.";

export interface StoredConversation {
  sessionId: string;
  title?: string;
  problem: string;
  createdAt: number;
  updatedAt: number;
  tutorModelId?: string;
  workingDirectory?: string;
  /** Set when the session ended through its end-of-session recap. */
  endedAt?: number;
  messages: StoredChatMessage[];
}

/** A saved message as the tutor server restores it; suggestions keep a role. */
export function tutorRestoreMessage(message: StoredChatMessage): {
  role: 'user' | 'tutor' | 'suggestion';
  text: string;
} {
  return {
    role: message.suggestion ? 'suggestion' : message.role,
    text: message.text,
  };
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'chat-conversations.json');
}

function writeConversations(conversations: StoredConversation[]): void {
  try {
    const file = storePath();
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(conversations, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (err) {
    log.warn('[conversation-store] save failed:', err);
  }
}

function isMessage(value: unknown): value is StoredChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<StoredChatMessage>;
  return (
    (message.role === 'user' || message.role === 'tutor') &&
    typeof message.text === 'string'
  );
}

function sameMessage(
  left: StoredChatMessage,
  right: StoredChatMessage,
): boolean {
  return (
    left.role === right.role &&
    left.text === right.text &&
    JSON.stringify(left.images ?? []) === JSON.stringify(right.images ?? [])
  );
}

export function deriveConversationTitle(
  problem: string,
  messages: StoredChatMessage[],
): string {
  const normalizedProblem = problem.replace(/\s+/g, ' ').trim();
  const firstUserMessage =
    messages.find((message) => message.role === 'user' && message.text.trim())
      ?.text ?? '';
  const candidate =
    normalizedProblem &&
    normalizedProblem.toLowerCase() !== 'general help session'
      ? normalizedProblem
      : firstUserMessage;
  const cleaned = candidate
    .replace(/[`#>*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'General help session';
  if (cleaned.length <= 72) return cleaned;
  const shortened = cleaned.slice(0, 72);
  const lastSpace = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, lastSpace >= 48 ? lastSpace : 72).trim()}…`;
}

/**
 * Reconcile a renderer snapshot with the transcript already on disk.
 *
 * Renderer reloads can preserve the Electron session id while losing React's
 * in-memory messages. In that case the first subsequent save is only the new
 * suffix of the conversation; replacing the stored snapshot would erase all
 * earlier turns. Full snapshots remain authoritative so retry edits still
 * replace the corresponding error response.
 */
export function mergeConversationMessages(
  existing: StoredChatMessage[],
  incoming: StoredChatMessage[],
): StoredChatMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  let commonPrefix = 0;
  while (
    commonPrefix < existing.length &&
    commonPrefix < incoming.length &&
    sameMessage(existing[commonPrefix], incoming[commonPrefix])
  ) {
    commonPrefix += 1;
  }

  if (commonPrefix > 0) {
    // Conversations do not support deleting turns, so any shorter snapshot is
    // stale or only partially rehydrated.
    if (incoming.length < existing.length) return existing;
    return incoming;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const matches = existing
      .slice(existing.length - overlap)
      .every((message, index) => sameMessage(message, incoming[index]));
    if (matches) return [...existing, ...incoming.slice(overlap)];
  }

  // No overlap means the renderer resumed with only brand-new turns.
  return [...existing, ...incoming];
}

export function readConversations(): StoredConversation[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is StoredConversation => {
        if (!value || typeof value !== 'object') return false;
        const conversation = value as Partial<StoredConversation>;
        return (
          typeof conversation.sessionId === 'string' &&
          typeof conversation.problem === 'string' &&
          typeof conversation.createdAt === 'number' &&
          typeof conversation.updatedAt === 'number' &&
          Array.isArray(conversation.messages) &&
          conversation.messages.every(isMessage)
        );
      })
      .map((conversation) => ({
        ...conversation,
        workingDirectory:
          typeof conversation.workingDirectory === 'string'
            ? conversation.workingDirectory
            : undefined,
        messages: conversation.messages.map((message) => ({
          ...message,
          activity: parseAgentActivity(message.activity),
        })),
        title:
          typeof conversation.title === 'string' && conversation.title.trim()
            ? conversation.title
            : deriveConversationTitle(
                conversation.problem,
                conversation.messages,
              ),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Keep folder choices even for drafts that have no messages yet. */
export function saveConversationDirectory(
  sessionId: string,
  workingDirectory: string,
): void {
  const conversations = readConversations();
  const existing = conversations.find((item) => item.sessionId === sessionId);
  if (existing) {
    existing.workingDirectory = workingDirectory;
  } else {
    conversations.push({
      sessionId,
      problem: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      workingDirectory,
    });
  }
  writeConversations(conversations);
}

export function saveConversation(input: {
  sessionId?: unknown;
  problem?: unknown;
  tutorModelId?: unknown;
  messages?: unknown;
}): void {
  if (
    typeof input.sessionId !== 'string' ||
    !input.sessionId ||
    !Array.isArray(input.messages) ||
    input.messages.length === 0
  ) {
    return;
  }

  const messages = input.messages.filter(isMessage).map((message) => {
    const suggestion = parseChatSuggestion(message.suggestion);
    return {
      role: message.role,
      text: message.text,
      tutorMetrics: parseMetrics(message.tutorMetrics),
      observerMetrics: parseMetrics(message.observerMetrics),
      ...(message.activity
        ? { activity: parseAgentActivity(message.activity) }
        : {}),
      ...(message.stopped ? { stopped: true } : {}),
      ...(Array.isArray(message.images)
        ? {
            images: message.images.filter((image) => typeof image === 'string'),
          }
        : {}),
      ...(message.isError === true ? { isError: true } : {}),
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      ...(typeof message.ts === 'number' ? { ts: message.ts } : {}),
      ...(suggestion ? { suggestion, folded: message.folded === true } : {}),
      ...(typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      ...(message.isStreaming === true ? { isStreaming: true } : {}),
      ...((message.isError === true || message.isStreaming === true) &&
      typeof message.retryText === 'string'
        ? {
            retryText: message.retryText,
            ...(message.retryRequestKind === 'chat' ||
            message.retryRequestKind === 'practice_suggestions'
              ? { retryRequestKind: message.retryRequestKind }
              : {}),
          }
        : {}),
    };
  });
  if (messages.length === 0) return;

  const now = Date.now();
  const conversations = readConversations();
  const existing = conversations.find(
    (conversation) => conversation.sessionId === input.sessionId,
  );
  const requestedProblem =
    typeof input.problem === 'string' ? input.problem.trim() : '';
  const tutorModelId =
    typeof input.tutorModelId === 'string' && input.tutorModelId
      ? input.tutorModelId
      : existing?.tutorModelId;
  const next: StoredConversation = {
    sessionId: input.sessionId,
    title:
      (existing?.messages.length ? existing.title : undefined) ||
      deriveConversationTitle(
        requestedProblem || existing?.problem || '',
        messages,
      ),
    problem: requestedProblem || existing?.problem || '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(tutorModelId ? { tutorModelId } : {}),
    ...(existing?.workingDirectory
      ? { workingDirectory: existing.workingDirectory }
      : {}),
    ...(existing?.endedAt ? { endedAt: existing.endedAt } : {}),
    messages: existing
      ? mergeConversationMessages(existing.messages, messages)
      : messages,
  };
  const updated = [
    next,
    ...conversations.filter(
      (conversation) => conversation.sessionId !== input.sessionId,
    ),
  ];

  writeConversations(updated);
}

/** The messages with one in-flight reply settled, or null to leave them as is. */
export function applyStoredReply(
  messages: StoredChatMessage[],
  requestId: string,
  reply: StoredReply,
  userText?: string,
): StoredChatMessage[] | null {
  const index = messages.findIndex(
    (message) => message.role === 'tutor' && message.requestId === requestId,
  );
  const base = index >= 0 ? messages[index] : undefined;
  // The renderer already saved the finished reply (or a retry replaced it).
  if (base && !base.isStreaming) return null;
  if (!base) {
    // The window closed before its first save of the pending reply; append it
    // only when it clearly answers the last saved user turn.
    const last = messages[messages.length - 1];
    if (!userText || last?.role !== 'user' || last.text !== userText.trim()) {
      return null;
    }
  }

  const rest: StoredChatMessage = { ...(base ?? { role: 'tutor', text: '' }) };
  const { retryText, retryRequestKind } = rest;
  const tutorMetrics = parseMetrics(reply.tutorMetrics);
  const observerMetrics = parseMetrics(reply.observerMetrics);
  if (tutorMetrics) rest.tutorMetrics = tutorMetrics;
  if (observerMetrics) rest.observerMetrics = observerMetrics;
  if (reply.activity) rest.activity = parseAgentActivity(reply.activity);
  if (reply.stopped) rest.stopped = true;
  delete rest.isStreaming;
  delete rest.isError;
  delete rest.retryText;
  delete rest.retryRequestKind;
  const settled: StoredChatMessage = reply.isError
    ? {
        ...rest,
        text: reply.text,
        requestId,
        isError: true,
        ...(retryText !== undefined ? { retryText } : {}),
        ...(retryRequestKind ? { retryRequestKind } : {}),
      }
    : {
        ...rest,
        text: reply.text,
        requestId,
        id: rest.id ?? randomUUID(),
        ts: Date.now(),
      };
  return base
    ? messages.map((message, i) => (i === index ? settled : message))
    : [...messages, settled];
}

/**
 * Record a streamed reply's final outcome directly from main.
 *
 * The renderer normally saves completed turns itself, but a chat window can be
 * closed or reloaded mid-stream. Settling the stored message here keeps the
 * reply instead of leaving its partial text saved as if it were final.
 */
export function settleStoredReply(
  sessionId: string,
  requestId: string,
  reply: StoredReply,
  userText?: string,
): void {
  const conversations = readConversations();
  const conversation = conversations.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!conversation) return;
  const messages = applyStoredReply(
    conversation.messages,
    requestId,
    reply,
    userText,
  );
  if (!messages) return;
  writeConversations(
    conversations.map((candidate) =>
      candidate === conversation
        ? { ...candidate, updatedAt: Date.now(), messages }
        : candidate,
    ),
  );
}

/**
 * Replace saved replies whose stream no longer exists (for example, the app
 * quit mid-reply) with a retryable error instead of their partial text.
 */
export function interruptStaleReplies(
  conversation: StoredConversation,
  isActive: (requestId: string) => boolean,
): StoredConversation {
  if (
    !conversation.messages.some(
      (message) =>
        message.isStreaming &&
        !(message.requestId && isActive(message.requestId)),
    )
  ) {
    return conversation;
  }
  return {
    ...conversation,
    messages: conversation.messages.map((message) => {
      if (!message.isStreaming) return message;
      if (message.requestId && isActive(message.requestId)) return message;
      const interrupted = {
        ...message,
        text: INTERRUPTED_REPLY_TEXT,
        activity: parseAgentActivity(message.activity, true),
        isError: true,
      };
      delete interrupted.isStreaming;
      return interrupted;
    }),
  };
}

/** Messages the tutor can be given as context: finished, successful turns. */
export function restorableMessages(
  messages: StoredChatMessage[],
  excludeTrailingUserText?: string,
) {
  const restorable = messages.filter(
    (message) => !message.isError && !message.isStreaming,
  );
  const last = restorable[restorable.length - 1];
  // The renderer may have saved the turn being sent before it is resumed;
  // that turn reaches the tutor as the new prompt, not as history.
  if (
    excludeTrailingUserText !== undefined &&
    last?.role === 'user' &&
    last.text === excludeTrailingUserText.trim()
  ) {
    restorable.pop();
  }
  return restorable.map(tutorRestoreMessage);
}

/**
 * The conversation to show when Coco opens without a current one: the most
 * recent one still in progress. An ended session opens a new chat instead.
 */
export function latestConversation(
  conversations: StoredConversation[],
): StoredConversation | null {
  const latest = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find((conversation) => conversation.messages.length > 0);
  return latest && !latest.endedAt ? latest : null;
}

/** Mark a conversation's session ended, or clear that when it is resumed. */
export function setConversationEnded(sessionId: string, ended: boolean): void {
  const conversations = readConversations();
  const conversation = conversations.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!conversation || Boolean(conversation.endedAt) === ended) return;
  writeConversations(
    conversations.map((candidate) => {
      if (candidate !== conversation) return candidate;
      if (ended) return { ...candidate, endedAt: Date.now() };
      const resumed = { ...candidate };
      delete resumed.endedAt;
      return resumed;
    }),
  );
}
