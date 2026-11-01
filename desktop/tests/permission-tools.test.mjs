import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPermissionTools,
  requireApproval,
} from '../release/app/agent/permission-tools.mjs';

test('real file tools allow workspace edits and reject traversal and symlink escapes', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-permissions-')),
  );
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  fs.symlinkSync(root, path.join(cwd, 'outside'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(cwd, 'dangling'));
  const tools = new Map(
    createPermissionTools(cwd).map((tool) => [tool.name, tool]),
  );
  const execute = (name, args) =>
    Promise.resolve().then(() => tools.get(name).execute('call', args));
  try {
    await execute('write', { path: 'nested/result.txt', content: 'hello' });
    await execute('edit', {
      path: 'nested/result.txt',
      edits: [{ oldText: 'hello', newText: 'updated' }],
    });
    assert.equal(
      fs.readFileSync(path.join(cwd, 'nested/result.txt'), 'utf8'),
      'updated',
    );
    assert.match(
      JSON.stringify(await execute('read', { path: 'nested/result.txt' })),
      /updated/,
    );
    for (const target of [
      '../secret.txt',
      path.join(root, 'secret.txt'),
      'outside/secret.txt',
    ]) {
      await assert.rejects(
        execute('read', { path: target }),
        /Permission denied/,
      );
      await assert.rejects(
        execute('write', { path: target, content: 'bad' }),
        /Permission denied/,
      );
      await assert.rejects(
        execute('edit', {
          path: target,
          edits: [{ oldText: 'secret', newText: 'bad' }],
        }),
        /Permission denied/,
      );
    }
    for (const name of ['ls', 'grep', 'find']) {
      await assert.rejects(
        execute(name, { path: 'outside', pattern: '*' }),
        /Permission denied/,
      );
    }
    await assert.rejects(
      execute('write', { path: 'outside/new/file.txt', content: 'bad' }),
      /Permission denied/,
    );
    await assert.rejects(
      execute('write', { path: 'dangling', content: 'bad' }),
      /Permission denied/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'secret.txt'), 'utf8'),
      'secret',
    );
    assert.equal(fs.existsSync(path.join(root, 'new')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approval is required each time and denial never invokes the executor', async () => {
  let calls = 0;
  let approvals = 0;
  const tool = {
    name: 'send_message',
    execute: async () => {
      calls += 1;
    },
  };
  await assert.rejects(
    requireApproval(tool, '/work').execute('a', {}),
    /Permission denied/,
  );
  await assert.rejects(
    requireApproval(tool, '/work', async () => false).execute('b', {}),
    /Permission denied/,
  );
  assert.equal(calls, 0);
  const guarded = requireApproval(tool, '/work', async (action) => {
    approvals += 1;
    assert.equal(action.arguments.recipient, 'person');
    return true;
  });
  await guarded.execute('c', { recipient: 'person' });
  await guarded.execute('d', { recipient: 'person' });
  assert.equal(calls, 2);
  assert.equal(approvals, 2);
});

test('approval snapshots arguments and a late approval cannot execute an aborted call', async () => {
  let release;
  let executed;
  const tool = {
    name: 'bash',
    execute: async (_id, args) => {
      executed = args;
    },
  };
  const approval = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const guarded = requireApproval(tool, '/work', approval);
  const args = { command: 'original' };
  const pending = guarded.execute('a', args);
  args.command = 'changed';
  release(true);
  await pending;
  assert.equal(executed.command, 'original');
  executed = undefined;
  const controller = new AbortController();
  const stopped = guarded.execute('b', {}, controller.signal);
  controller.abort();
  release(true);
  await assert.rejects(stopped, /aborted/);
  assert.equal(executed, undefined);
});

test('curated packages are readable outside the workspace but never writable and cannot escape through symlinks', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-skill-permissions-')),
  );
  try {
    const cwd = path.join(root, 'workspace');
    const skill = path.join(root, 'skills', 'alice', 'weekly-update');
    fs.mkdirSync(cwd);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Instructions');
    fs.writeFileSync(path.join(skill, 'template.md'), 'Template');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'Secret');
    fs.symlinkSync(
      path.join(root, 'secret.txt'),
      path.join(skill, 'escape.md'),
    );
    const tools = new Map(
      createPermissionTools(cwd, undefined, [skill]).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const run = (name, args) =>
      Promise.resolve().then(() => tools.get(name).execute('test', args));
    assert.match(
      JSON.stringify(await run('read', { path: path.join(skill, 'SKILL.md') })),
      /Instructions/,
    );
    assert.match(
      JSON.stringify(
        await run('read', { path: path.join(skill, 'template.md') }),
      ),
      /Template/,
    );
    await assert.rejects(
      run('read', { path: path.join(skill, 'escape.md') }),
      /Permission denied/,
    );
    await assert.rejects(
      run('read', { path: path.join(root, 'secret.txt') }),
      /Permission denied/,
    );
    await assert.rejects(
      run('write', { path: path.join(skill, 'SKILL.md'), content: 'bad' }),
      /Permission denied/,
    );
    await assert.rejects(
      run('edit', {
        path: path.join(skill, 'SKILL.md'),
        edits: [{ oldText: 'Instructions', newText: 'bad' }],
      }),
      /Permission denied/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
