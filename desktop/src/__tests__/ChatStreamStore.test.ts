/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import ChatStreamStore from '../main/services/chat-stream-store';
import {
  readConversations,
  saveConversation,
  tutorRestoreMessage,
} from '../main/conversation-store';
jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

it('saves interleaved background replies, questions, and completion without stale regression', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-concurrent-'));
  (app.getPath as jest.Mock).mockReturnValue(directory);
  const store = new ChatStreamStore();
  try {
    store.begin('a', 'ra', 'Task A', [], false, undefined, 'Draft A is open.');
    store.begin('b', 'rb', 'Task B');
    store.accept('ra', { type: 'text_delta', text: 'A is thinking' });
    store.accept('rb', {
      type: 'agent_activity',
      text: '',
      activity: [
        {
          kind: 'tool',
          call: {
            id: 'q',
            name: 'ask_user_question',
            status: 'running',
            arguments: {},
            result: { waitingForAnswer: true, questions: [] },
          },
        },
      ],
    });
    store.flush('ra');
    store.flush('rb');
    const saved = readConversations(() => true);
    expect(saved.find((item) => item.sessionId === 'a')?.messages[1].text).toBe(
      'A is thinking',
    );
    expect(
      saved.find((item) => item.sessionId === 'b')?.messages[1].activity?.[0],
    ).toMatchObject({ call: { status: 'running' } });
    const userA = saved.find((item) => item.sessionId === 'a')!.messages[0];
    expect(userA.screenContext).toBe('Draft A is open.');
    expect(tutorRestoreMessage(userA).text).toContain(
      'Draft A is open.\n</screen_observation>\nTask A',
    );
    expect(saved.find((item) => item.sessionId === 'b')!.messages[0].screenContext)
      .toBeUndefined();
    const stale = saved.find((item) => item.sessionId === 'a')!;
    store.accept('ra', { type: 'done', guidance: 'A finished' });
    store.finish('ra');
    saveConversation(stale);
    expect(
      readConversations(() => true).find((item) => item.sessionId === 'b')
        ?.messages[1].activity?.[0],
    ).toMatchObject({ call: { status: 'running' } });
    expect(
      readConversations().find((item) => item.sessionId === 'a')?.messages[1],
    ).toMatchObject({ text: 'A finished' });
    expect(
      readConversations().find((item) => item.sessionId === 'a')?.messages[1]
        .isStreaming,
    ).toBeFalsy();
    store.accept('rb', { type: 'done', guidance: 'B stopped', stopped: true });
    store.finish('rb');
    expect(
      readConversations().find((item) => item.sessionId === 'b')?.messages[1],
    ).toMatchObject({ stopped: true, text: 'B stopped' });
  } finally {
    store.finish('ra');
    store.finish('rb');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
