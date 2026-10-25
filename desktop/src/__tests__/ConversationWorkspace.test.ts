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

it('retains token usage across saved snapshots and reopening a conversation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-metrics-'));
  (app.getPath as jest.Mock).mockReturnValue(directory);
  const tutorMetrics = {
    prompt_tokens: 1234,
    completion_tokens: 321,
    total_tokens: 1555,
    duration_ms: 2300,
    model: 'test-model',
  };
  const observerMetrics = {
    input_tokens: 400,
    output_tokens: 0,
    duration_ms: 500,
  };
  try {
    saveConversation({
      sessionId: 'metrics',
      messages: [
        { role: 'tutor', text: 'Answer', tutorMetrics, observerMetrics },
      ],
    });
    const conversation = readConversations()[0];
    expect(conversation.messages[0]).toMatchObject({
      tutorMetrics,
      observerMetrics,
    });
    saveConversation(conversation);
    expect(readConversations()[0].messages[0]).toMatchObject({
      tutorMetrics,
      observerMetrics,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
