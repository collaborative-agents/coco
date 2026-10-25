import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAuthController,
  createModelRuntime,
} from '../release/app/agent/pi-auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(login) {
  const opened = [];
  const runtime = {
    getProviders: () => [
      { id: 'test', name: 'Test', auth: { oauth: { name: 'Sign in' } } },
    ],
    getProvider: () => ({ auth: { oauth: {} } }),
    getModels: () => [],
    hasConfiguredAuth: () => false,
    refresh: async () => ({ errors: new Map() }),
    login,
  };
  return {
    auth: createAuthController(runtime, (url) => opened.push(url)),
    opened,
  };
}
test('OAuth browser and manual callback exchange stays inside the auth controller', async () => {
  let answer;
  const { auth, opened } = fixture(async (_provider, _type, interaction) => {
    interaction.notify({ type: 'auth_url', url: 'https://example.com/login' });
    answer = await interaction.prompt({
      type: 'manual_code',
      message: 'Paste callback',
    });
    return { access: 'private-token', refresh: 'private-refresh' };
  });
  auth.login('test', 'oauth');
  const status = await auth.status();
  assert.deepEqual(opened, ['https://example.com/login']);
  auth.answer(status.flow.prompt.id, 'callback-code');
  await tick();
  assert.equal(answer, 'callback-code');
  assert.equal((await auth.status()).flow.busy, false);
  assert.doesNotMatch(
    JSON.stringify(await auth.status()),
    /private-token|private-refresh|callback-code/,
  );
  assert.throws(() => auth.answer(status.flow.prompt.id, 'stale'), /expired/);
});
test('cancel aborts prompts; concurrent login and unsafe browser URLs are rejected', async () => {
  const { auth } = fixture(async (_p, _t, i) =>
    i.prompt({ type: 'secret', message: 'Key' }),
  );
  auth.login('test', 'oauth');
  assert.throws(() => auth.login('test', 'oauth'), /cancel/);
  await auth.cancel();
  assert.equal((await auth.status()).flow.prompt, undefined);
  assert.equal((await auth.status()).flow.busy, false);
  const unsafe = fixture(async (_p, _t, i) =>
    i.notify({ type: 'auth_url', url: 'file:///tmp/test' }),
  );
  unsafe.auth.login('test', 'oauth');
  await tick();
  assert.equal(unsafe.opened.length, 0);
});
test('callback arrival cancels a manual prompt without cancelling the entire login', async () => {
  const callback = new AbortController();
  const { auth } = fixture(async (_p, _t, i) => {
    await i
      .prompt({
        type: 'manual_code',
        message: 'Callback',
        signal: callback.signal,
      })
      .catch(() => {});
    assert.equal(i.signal.aborted, false);
  });
  auth.login('test', 'oauth');
  callback.abort();
  await tick();
  assert.equal((await auth.status()).flow.busy, false);
});
test('real SDK exposes native OAuth providers and catalogs without a Coco service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-auth-'));
  try {
    const runtime = await createModelRuntime(dir);
    assert.ok(runtime.getProviders().some((p) => p.auth.oauth));
    assert.ok(runtime.getModels().some((m) => m.provider !== 'coco'));
    assert.equal(runtime.getProvider('coco'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
