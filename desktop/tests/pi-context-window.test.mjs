import assert from 'node:assert/strict';
import test from 'node:test';
import { contextWindowForModel } from '../release/app/agent/pi-context-window.mjs';

const models = [
  { provider: 'google', id: 'gemini-2.5-pro', contextWindow: 1048576 },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 1000000 },
  { provider: 'openai', id: 'gpt-5.3-codex', contextWindow: 400000 },
  { provider: 'deepseek', id: 'deepseek-v4-pro', contextWindow: 1000000 },
];

test('Coco provider names use exact catalog capacities', () => {
  for (const model of models) {
    const provider = model.provider === 'google' ? 'gemini' : model.provider;
    assert.equal(contextWindowForModel(`${provider}/${model.id}`, models), model.contextWindow);
  }
});

test('unknown models and self-hosted deployments retain the fallback', () => {
  for (const model of ['hosted_vllm/claude-sonnet-4-6', 'anthropic/unknown', 'unknown', ''])
    assert.equal(contextWindowForModel(model, models), 64000);
});

test('ambiguous variants use the smallest valid capacity, including smaller models', () => {
  const variants = [NaN, 0, -1, 128000, 32000].map(contextWindow => ({
    provider: 'openai', id: 'test', contextWindow,
  }));
  assert.equal(contextWindowForModel('openai/test', variants), 32000);
});
