/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import TokenUsageStore from './token-usage';

test('usage survives restart, deduplicates completion, and preserves unknown counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-usage-'));
  const file = path.join(root, 'usage.json');
  try {
    const store = new TokenUsageStore(file);
    store.observe('session', 'one', {
      type: 'done',
      llm_metrics: { model: 'test', prompt_tokens: 12, completion_tokens: 3 },
    });
    store.observe('session', 'one', { type: 'done' });
    store.observe('session', 'two', { type: 'error' });
    const { requests } = new TokenUsageStore(file).read();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      input: 12,
      output: 3,
      successful: true,
    });
    expect(requests[1]).toMatchObject({
      input: null,
      output: null,
      successful: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
