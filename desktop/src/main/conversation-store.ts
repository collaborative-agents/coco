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
  problem: string;
  createdAt: number;
  updatedAt: number;
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
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversation(input: {
  sessionId?: unknown;
  problem?: unknown;
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
  const next: StoredConversation = {
    sessionId: input.sessionId,
    problem: typeof input.problem === 'string' ? input.problem : '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages,
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
