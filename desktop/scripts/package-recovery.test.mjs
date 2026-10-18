import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { retry, isTransient } from './retry-command.mjs';
import { notarize, submissionId, assertAccepted } from './notarize-app.mjs';

test('retries the reported DNS and Apple connection failures with bounded backoff', async () => {
  let calls = 0;
  const delays = [];
  const value = await retry(
    () => {
      calls += 1;
      if (calls === 1) throw new Error('getaddrinfo ENOTFOUND github.com');
      if (calls === 2)
        throw new Error(
          'NSURLErrorDomain Code=-1005 The network connection was lost.',
        );
      return 'ok';
    },
    { sleep: async (delay) => delays.push(delay) },
  );
  assert.equal(value, 'ok');
  assert.deepEqual(delays, [15000, 30000]);
});

test('stops after four transport failures and fails deterministic errors immediately', async () => {
  for (const [message, expected] of [
    ['ENOTFOUND github.com', 4],
    ['Invalid credentials (401)', 1],
    ['signature invalid', 1],
  ]) {
    let calls = 0;
    await assert.rejects(
      retry(
        () => {
          calls += 1;
          throw new Error(message);
        },
        { sleep: async () => {} },
      ),
    );
    assert.equal(calls, expected);
  }
  assert.equal(
    isTransient('The staple and validate action failed! Error 68.'),
    false,
  );
});

test('persists submission before waiting and resumes the same ID without another upload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coco-notary-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.APPLE_API_KEY = '/fake/key.p8';
  process.env.APPLE_API_KEY_ID = 'fake-key';
  process.env.APPLE_API_ISSUER = 'fake-issuer';
  const receipt = join(dir, 'receipt.json');
  const id = '12345678-1234-1234-1234-123456789abc';
  await notarize('submit', '/fake/app.zip', receipt, (command, args) => {
    assert.equal(command, 'xcrun');
    assert.deepEqual(args.slice(0, 3), [
      'notarytool',
      'submit',
      '/fake/app.zip',
    ]);
    assert.equal(args.includes('--wait'), false);
    return JSON.stringify({ id });
  });
  assert.equal(JSON.parse(readFileSync(receipt)).id, id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await notarize('wait', '/fake/app.zip', receipt, (command, args) => {
      assert.deepEqual(args.slice(0, 3), ['notarytool', 'wait', id]);
      return JSON.stringify({ id, status: 'Accepted' });
    });
  }
  await assert.rejects(
    notarize('wait', '/fake/app.zip', receipt, (_, args) => {
      if (args[1] === 'log') return '{}';
      return JSON.stringify({ id, status: 'Invalid' });
    }),
    /not accepted/,
  );
  const invalidReceipt = join(dir, 'invalid.json');
  await assert.rejects(
    notarize('submit', '/fake/app.zip', invalidReceipt, () => '{}'),
    /submission ID/,
  );
  assert.equal(existsSync(invalidReceipt), false);
});

test('missing, malformed, and nonaccepted responses fail closed', () => {
  for (const status of ['Invalid', 'Rejected', 'In Progress', undefined]) {
    assert.throws(() => assertAccepted({ status }), /not accepted/);
  }
  assert.throws(() => submissionId({ id: 'not-an-id' }), /submission ID/);
});
