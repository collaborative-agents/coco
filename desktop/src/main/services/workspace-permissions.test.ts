/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import WorkspacePermissions from './workspace-permissions';
import AgentPermissions from './agent-permissions';

let root: string;
let workspace: string;
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-workspace-rules-')),
  );
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('workspace allow persists across brokers and store reloads, and can be revoked', async () => {
  const store = new WorkspacePermissions(root);
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, undefined, store);
  const pending = broker.request(
    { kind: 'workspace', directory: workspace },
    new AbortController().signal,
  );
  broker.answer(publish.mock.calls[0][0].id, true);
  await expect(pending).resolves.toBe(true);
  const reloaded = new WorkspacePermissions(root);
  const next = jest.fn();
  await expect(
    new AgentPermissions(next, undefined, reloaded).request(
      { kind: 'workspace', directory: workspace },
      new AbortController().signal,
    ),
  ).resolves.toBe(true);
  expect(next.mock.calls[0][0]).toMatchObject({
    status: 'allowed',
    approvalSource: 'saved-rule',
  });
  expect(reloaded.hasWorkspace(root)).toBe(false);
  expect(
    new WorkspacePermissions(root, 'another-user').hasWorkspace(workspace),
  ).toBe(false);
  reloaded.revokeWorkspace(workspace);
  expect(store.hasWorkspace(workspace)).toBe(false);
});

test('saved external access is scoped by workspace, mode, exact file or directory boundary', async () => {
  const store = new WorkspacePermissions(root);
  const file = {
    path: path.join(root, 'outside', 'data.txt'),
    mode: 'read' as const,
    scope: 'file' as const,
  };
  const input = {
    kind: 'path' as const,
    directory: workspace,
    tool: 'read',
    fileAccess: file,
  };
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, undefined, store);
  const once = broker.request(input, new AbortController().signal);
  broker.answer(publish.mock.calls.at(-1)[0].id, true);
  await once;
  expect(store.matches(workspace, file)).toBe(false);
  const saved = broker.request(input, new AbortController().signal);
  broker.answer(publish.mock.calls.at(-1)[0].id, 'always');
  await saved;
  const reloaded = new WorkspacePermissions(root);
  expect(reloaded.matches(workspace, file)).toBe(true);
  expect(reloaded.matches(workspace, { ...file, mode: 'write' })).toBe(false);
  expect(reloaded.matches(root, file)).toBe(false);
  expect(
    reloaded.matches(workspace, { ...file, path: file.path + '.backup' }),
  ).toBe(false);
  expect(reloaded.matches(workspace, { ...file, scope: 'directory' })).toBe(
    false,
  );
  reloaded.allow(workspace, {
    path: path.dirname(file.path),
    mode: 'write',
    scope: 'directory',
  });
  expect(store.matches(workspace, { ...file, mode: 'write' })).toBe(true);
  expect(
    store.matches(workspace, {
      ...file,
      path: path.join(root, 'outside-other', 'data.txt'),
    }),
  ).toBe(false);
  for (const rule of store.list(workspace)) store.revoke(workspace, rule.id);
  expect(reloaded.matches(workspace, file)).toBe(false);
});

test('denial, cancellation and stale answers never persist grants', async () => {
  const store = new WorkspacePermissions(root);
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, undefined, store);
  const controller = new AbortController();
  const pending = broker.request(
    { kind: 'workspace', directory: workspace },
    controller.signal,
  );
  const id = publish.mock.calls.at(-1)[0].id;
  controller.abort();
  await pending;
  expect(() => broker.answer(id, true)).toThrow('no longer active');
  const denied = broker.request(
    { kind: 'workspace', directory: workspace },
    new AbortController().signal,
  );
  broker.answer(publish.mock.calls.at(-1)[0].id, false);
  await denied;
  expect(store.list(workspace)).toEqual([]);
});
