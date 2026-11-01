/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import CommandApprovalRules, { commandPrefix } from './command-approval-rules';
import AgentPermissions from './agent-permissions';

let root: string;
let workspace: string;
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-command-rules-')),
  );
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('explicit reusable approval persists across brokers, scopes to account and directory, and can be revoked', async () => {
  const store = new CommandApprovalRules(root, 'alice');
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, store);
  const input = {
    kind: 'action' as const,
    tool: 'bash',
    directory: workspace,
    arguments: { command: 'npm test -- --runInBand' },
  };
  const pending = broker.request(input, new AbortController().signal);
  expect(publish.mock.calls[0][0].suggestedPrefix).toEqual(['npm', 'test']);
  broker.answer(publish.mock.calls[0][0].id, 'always');
  await expect(pending).resolves.toBe(true);
  const reloaded = new CommandApprovalRules(root, 'alice');
  const nextPublish = jest.fn();
  await expect(
    new AgentPermissions(nextPublish, reloaded).request(
      { ...input, arguments: { command: 'npm test -- --watch' } },
      new AbortController().signal,
    ),
  ).resolves.toBe(true);
  expect(nextPublish).toHaveBeenCalledTimes(1);
  expect(nextPublish.mock.calls[0][0]).toMatchObject({
    status: 'allowed',
    approvalSource: 'saved-rule',
  });
  expect(
    new CommandApprovalRules(root, 'bob').matches(workspace, 'npm test'),
  ).toBe(false);
  expect(reloaded.matches(root, 'npm test')).toBe(false);
  expect(reloaded.matches(workspace, 'npm testing')).toBe(false);
  reloaded.revoke(workspace, reloaded.list(workspace)[0].id);
  expect(store.matches(workspace, 'npm test')).toBe(false);
});

test.each([
  'npm test && rm -rf /tmp/example',
  'npm test; echo surprise',
  'npm test | sh',
  'npm test $(touch bad)',
  'npm test `touch bad`',
  'npm test > result.txt',
  'npm test\necho bad',
  'npm test "$HOME"',
  'npm test *',
  'FOO=bar npm test',
  'bash -c npm-test',
  'python script.py',
  'rm -rf temp',
  'npm run',
  'npm test #comment',
  'npm test \\;echo',
  'npm test (echo x)',
])(
  'does not offer or reuse a prefix for shell syntax or unsupported commands: %s',
  (command) => {
    const store = new CommandApprovalRules(root, 'alice');
    store.allow(workspace, 'npm test');
    expect(commandPrefix(command)).toBeNull();
    expect(store.matches(workspace, command)).toBe(false);
    expect(() => store.allow(workspace, command)).toThrow('one-time approval');
  },
);

test('keeps named scripts narrow and handles repeated approvals without duplicate rules', () => {
  const store = new CommandApprovalRules(root, 'alice');
  store.allow(workspace, 'npm run build');
  store.allow(workspace, 'npm run build -- --watch');
  expect(store.list(workspace)).toHaveLength(1);
  expect(store.matches(workspace, 'npm run deploy')).toBe(false);
  expect(store.matches(workspace, 'npm run build -- --watch')).toBe(true);
});

test('one-time decisions, cancellation, training without a policy, and failed saves never create rules', async () => {
  const store = new CommandApprovalRules(root, 'alice');
  const input = {
    kind: 'action' as const,
    tool: 'bash',
    directory: workspace,
    arguments: { command: 'npm test' },
  };
  for (const choice of [true, false]) {
    const publish = jest.fn();
    const broker = new AgentPermissions(publish, store);
    const pending = broker.request(input, new AbortController().signal);
    broker.answer(publish.mock.calls[0][0].id, choice);
    await expect(pending).resolves.toBe(choice);
    expect(store.list(workspace)).toEqual([]);
  }
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, store);
  const abort = new AbortController();
  const pending = broker.request(input, abort.signal);
  abort.abort();
  expect(() => broker.answer(publish.mock.calls[0][0].id, 'always')).toThrow(
    'no longer active',
  );
  await expect(pending).resolves.toBe(false);
  store.allow(workspace, 'npm test');
  const training = new AgentPermissions(publish);
  const trial = training.request(input, new AbortController().signal);
  const request = publish.mock.calls.at(-1)![0];
  expect(request.status).toBe('pending');
  expect(request.suggestedPrefix).toBeUndefined();
  expect(() => training.answer(request.id, 'always')).toThrow('unavailable');
  training.answer(request.id, false);
  await expect(trial).resolves.toBe(false);
});

test('rejects an account change before saving and keeps the request pending for a one-time decision', async () => {
  let current = 'alice';
  const store = new CommandApprovalRules(root, 'alice', () => {
    if (current !== 'alice') throw new Error('Account changed');
  });
  const publish = jest.fn();
  const broker = new AgentPermissions(publish, store);
  const pending = broker.request(
    {
      kind: 'action',
      tool: 'bash',
      directory: workspace,
      arguments: { command: 'git status' },
    },
    new AbortController().signal,
  );
  current = 'bob';
  expect(() => broker.answer(publish.mock.calls[0][0].id, 'always')).toThrow(
    'Account changed',
  );
  broker.cancel();
  await expect(pending).resolves.toBe(false);
  expect(new CommandApprovalRules(root, 'alice').list(workspace)).toEqual([]);
});
