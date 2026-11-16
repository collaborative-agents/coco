import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserExtensions } from '../release/app/agent/pi-browser.mjs';

test('browser defaults on, permits opting out, and ignores workspace MCP configuration', (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-browser-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const options = { agentDir, cwd: agentDir, sessionKey: 'test' };
  fs.mkdirSync(path.join(agentDir, '.pi'));
  fs.writeFileSync(
    path.join(agentDir, '.pi/mcp.json'),
    '{"mcpServers":{"bad":{"command":"bad"}}}',
  );
  assert.equal(browserExtensions(options).length, 2);
  assert.equal(fs.existsSync(path.join(agentDir, 'browser.json')), false);
  fs.writeFileSync(path.join(agentDir, 'browser.json'), '{}');
  assert.equal(browserExtensions(options).length, 2);
  fs.writeFileSync(path.join(agentDir, 'browser.json'), '{"enabled":false}');
  assert.deepEqual(browserExtensions(options), []);
  fs.writeFileSync(
    path.join(agentDir, 'browser.json'),
    '{"enabled":true,"command":"relative"}',
  );
  assert.throws(() => browserExtensions(options), /absolute path/);
  fs.writeFileSync(path.join(agentDir, 'browser.json'), 'invalid');
  assert.throws(
    () => browserExtensions(options),
    /Cannot read browser configuration/,
  );
});

test('browser approval gates tools, preserves arguments, and respects cancellation', async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-browser-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, 'browser.json'), '{"enabled":true}');
  let allowed = false;
  let requests = 0;
  const controller = new AbortController();
  const extensions = browserExtensions({
    agentDir,
    cwd: agentDir,
    sessionKey: 'test',
    requestApproval: async (request, signal) => {
      requests++;
      assert.equal(signal, controller.signal);
      assert.equal(request.tool, 'mcp__browser__browser_navigate');
      request.arguments.url = 'mutated';
      return allowed;
    },
  });
  let handler;
  extensions[1]({
    on: (name, fn) => {
      assert.equal(name, 'tool_call');
      handler = fn;
    },
  });
  const event = {
    toolName: 'mcp__browser__browser_navigate',
    toolCallId: 'one',
    input: { url: 'https://example.com' },
  };
  const ctx = { signal: controller.signal };
  assert.equal((await handler(event, ctx)).block, true);
  allowed = true;
  assert.equal(await handler(event, ctx), undefined);
  assert.equal(event.input.url, 'https://example.com');
  assert.equal(await handler({ toolName: 'read' }, ctx), undefined);
  controller.abort();
  assert.equal((await handler(event, ctx)).block, true);
  assert.equal(requests, 2);
});
