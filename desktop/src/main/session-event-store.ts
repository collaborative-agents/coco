/**
 * Append-only local audit trail for the small set of session milestones used
 * by the Activity/usage analysis. Keeping events as JSONL means a crash can, at
 * worst, damage the final line without losing earlier sessions.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import type { SessionStartTrigger } from '../shared/session-start';

export type SessionEvent =
  | {
      event: 'session_started';
      session_id: string;
      started_at: string;
      start_trigger: SessionStartTrigger;
      user_id?: string;
    }
  | {
      event: 'session_ended';
      session_id: string;
      ended_at: string;
      recap_completed_at: string;
      quiz_skipped: boolean;
      quiz_answered: boolean;
      quiz_correct?: boolean;
      selected_index?: number;
      user_id?: string;
    };

function eventPath(): string {
  return path.join(app.getPath('userData'), 'session-events.jsonl');
}

function appendSessionEvent(event: SessionEvent): void {
  try {
    fs.appendFileSync(eventPath(), `${JSON.stringify(event)}\n`);
  } catch (error) {
    log.warn('[session-event-store] append failed:', error);
  }
}

export function recordSessionStarted(
  sessionId: string,
  userId: string | null,
  startTrigger: SessionStartTrigger,
  now = new Date(),
): void {
  appendSessionEvent({
    event: 'session_started',
    session_id: sessionId,
    started_at: now.toISOString(),
    start_trigger: startTrigger,
    ...(userId ? { user_id: userId } : {}),
  });
}

export function recordSessionEnded(
  sessionId: string,
  userId: string | null,
  result: {
    quizSkipped: boolean;
    quizAnswered: boolean;
    quizCorrect?: boolean;
    selectedIndex?: number;
  },
  now = new Date(),
): void {
  const endedAt = now.toISOString();
  appendSessionEvent({
    event: 'session_ended',
    session_id: sessionId,
    ended_at: endedAt,
    recap_completed_at: endedAt,
    quiz_skipped: result.quizSkipped,
    quiz_answered: result.quizAnswered,
    ...(typeof result.quizCorrect === 'boolean'
      ? { quiz_correct: result.quizCorrect }
      : {}),
    ...(typeof result.selectedIndex === 'number'
      ? { selected_index: result.selectedIndex }
      : {}),
    ...(userId ? { user_id: userId } : {}),
  });
}
