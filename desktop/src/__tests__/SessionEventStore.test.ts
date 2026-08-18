import fs from 'fs';
import os from 'os';
import path from 'path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-session-events-'));

jest.mock('electron', () => ({
  app: { getPath: () => testDir },
}));

jest.mock('electron-log', () => ({
  warn: jest.fn(),
}));

import {
  recordSessionEnded,
  recordSessionStarted,
} from '../main/session-event-store';

describe('local session event storage', () => {
  const file = path.join(testDir, 'session-events.jsonl');

  beforeEach(() => {
    fs.rmSync(file, { force: true });
  });

  function events() {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('records when a user accepts a session', () => {
    recordSessionStarted(
      'session-1',
      'user-1',
      'proactive_suggestion',
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(events()).toEqual([
      {
        event: 'session_started',
        session_id: 'session-1',
        started_at: '2026-08-05T10:00:00.000Z',
        start_trigger: 'proactive_suggestion',
        user_id: 'user-1',
      },
    ]);
  });

  it('records a skipped recap quiz and its completion time', () => {
    recordSessionEnded(
      'session-1',
      null,
      { quizSkipped: true, quizAnswered: false },
      new Date('2026-08-05T10:15:00.000Z'),
    );

    expect(events()).toEqual([
      {
        event: 'session_ended',
        session_id: 'session-1',
        ended_at: '2026-08-05T10:15:00.000Z',
        recap_completed_at: '2026-08-05T10:15:00.000Z',
        quiz_skipped: true,
        quiz_answered: false,
      },
    ]);
  });

  it('records the selected answer and correctness for a completed quiz', () => {
    recordSessionEnded(
      'session-1',
      'user-1',
      {
        quizSkipped: false,
        quizAnswered: true,
        quizCorrect: false,
        selectedIndex: 2,
      },
      new Date('2026-08-05T10:20:00.000Z'),
    );

    expect(events()[0]).toMatchObject({
      event: 'session_ended',
      ended_at: '2026-08-05T10:20:00.000Z',
      recap_completed_at: '2026-08-05T10:20:00.000Z',
      quiz_skipped: false,
      quiz_answered: true,
      quiz_correct: false,
      selected_index: 2,
      user_id: 'user-1',
    });
  });
});
