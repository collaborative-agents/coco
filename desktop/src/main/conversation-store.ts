/**
 * Local, cross-session storage for conversations shown in the chat panel.
 *
 * The renderer sends a complete snapshot after a conversation changes. Keeping
 * one JSON record per conversation makes history reads simple and lets a crash
 * leave, at worst, the previous complete snapshot intact.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export interface StoredChatMessage {
  role: 'user' | 'tutor';
  text: string;
  images?: string[];
  isError?: boolean;
  id?: string;
  ts?: number;
}

export interface StoredConversation {
  sessionId: string;
  title?: string;
  problem: string;
  createdAt: number;
  updatedAt: number;
  tutorModelId?: string;
  messages: StoredChatMessage[];
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'chat-conversations.json');
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

  const messages = input.messages.filter(isMessage).map((message) => ({
    role: message.role,
    text: message.text,
    ...(Array.isArray(message.images)
      ? { images: message.images.filter((image) => typeof image === 'string') }
      : {}),
    ...(message.isError === true ? { isError: true } : {}),
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    ...(typeof message.ts === 'number' ? { ts: message.ts } : {}),
  }));
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
      existing?.title ||
      deriveConversationTitle(
        requestedProblem || existing?.problem || '',
        messages,
      ),
    problem: requestedProblem || existing?.problem || '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(tutorModelId ? { tutorModelId } : {}),
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

  try {
    const file = storePath();
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(updated));
    fs.renameSync(temp, file);
  } catch (err) {
    log.warn('[conversation-store] save failed:', err);
  }
}
