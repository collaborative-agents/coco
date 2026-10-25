import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatThinkingLevel } from '../release/app/agent/pi-thinking.mjs';

test('Gemini chat uses low thinking for direct, Vertex and alias models', () => {
  for (const api of ['google-generative-ai', 'google-vertex']) {
    for (const id of [
      'gemini-3.7-flash',
      'gemini-flash-latest',
      'gemini-3.1-pro',
      'gemini-2.5-pro',
    ]) {
      assert.equal(chatThinkingLevel({ api, id, reasoning: true }), 'low');
    }
  }
});

test('other providers and non-reasoning models keep thinking off', () => {
  for (const model of [
    { api: 'openai-completions', id: 'coco', reasoning: false },
    { api: 'anthropic-messages', id: 'claude', reasoning: true },
    { api: 'google-generative-ai', id: 'gemini', reasoning: false },
    { api: 'google-generative-ai', id: 'gemma', reasoning: true },
  ]) {
    assert.equal(chatThinkingLevel(model), 'off');
  }
});
