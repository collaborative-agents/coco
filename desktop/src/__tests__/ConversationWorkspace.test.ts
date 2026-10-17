/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import {
  readConversations,
  saveConversation,
  saveConversationDirectory,
} from '../main/conversation-store';

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

it('persists independent folders for drafts and keeps them through transcript saves', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-folders-'));
  (app.getPath as jest.Mock).mockReturnValue(directory);
  try {
    saveConversationDirectory('session-a', '/work/project');
    saveConversationDirectory('session-b', '/work/reports');
    saveConversation({
      sessionId: 'session-a',
      messages: [{ role: 'user', text: 'Analyze this project' }],
    });
    saveConversationDirectory('session-b', '/work/new-reports');
    saveConversation({
      sessionId: 'session-a',
      messages: [{ role: 'tutor', text: 'Here is the analysis' }],
    });
    const saved = readConversations();
    expect(saved.find((item) => item.sessionId === 'session-a')).toMatchObject({
      workingDirectory: '/work/project',
      title: 'Analyze this project',
      messages: [
        { role: 'user', text: 'Analyze this project' },
        { role: 'tutor', text: 'Here is the analysis' },
      ],
    });
    expect(saved.find((item) => item.sessionId === 'session-b')).toMatchObject({
      workingDirectory: '/work/new-reports',
      messages: [],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
