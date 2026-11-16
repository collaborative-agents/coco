/** @jest-environment node */
import AgentPermissions from './agent-permissions';
import { parseAgentActivity } from '../../shared/agent-execution';

test('only a pending request in its own broker can be approved once', async () => {
  const publish = jest.fn();
  const broker = new AgentPermissions(publish);
  const other = new AgentPermissions(jest.fn());
  const pending = broker.request(
    { kind: 'workspace', directory: '/work' },
    new AbortController().signal,
  );
  const request = publish.mock.calls[0][0];
  expect(request.status).toBe('pending');
  expect(() => other.answer(request.id, true)).toThrow('no longer active');
  expect(() => broker.answer(request.id, 'yes')).toThrow('Invalid');
  broker.answer(request.id, true);
  await expect(pending).resolves.toBe(true);
  expect(publish.mock.calls[1][0].status).toBe('allowed');
  expect(() => broker.answer(request.id, true)).toThrow('no longer active');
});

test('denial and cancellation resolve without execution and old approvals stay inactive', async () => {
  const publish = jest.fn();
  const broker = new AgentPermissions(publish);
  const controller = new AbortController();
  const pending = broker.request(
    {
      kind: 'action',
      directory: '/work',
      tool: 'bash',
      arguments: { command: 'echo test' },
    },
    controller.signal,
  );
  const request = publish.mock.calls[0][0];
  controller.abort();
  await expect(pending).resolves.toBe(false);
  expect(publish.mock.calls[1][0].status).toBe('cancelled');
  expect(() => broker.answer(request.id, true)).toThrow('no longer active');
  const denied = broker.request(
    { kind: 'workspace', directory: '/other' },
    new AbortController().signal,
  );
  broker.answer(publish.mock.calls[2][0].id, false);
  await expect(denied).resolves.toBe(false);
  expect(
    parseAgentActivity([{ kind: 'permission', request }], true)?.[0],
  ).toEqual({
    kind: 'permission',
    request: { ...request, status: 'cancelled' },
  });
});

test('auto mode approves pending and future actions only within this run', async () => {
  const publish = jest.fn();
  const broker = new AgentPermissions(publish);
  const signal = new AbortController().signal;
  const action = {
    kind: 'action' as const,
    directory: '/work',
    tool: 'bash',
    arguments: { command: 'cua-driver call list_apps' },
  };
  const first = broker.request(action, signal);
  const second = broker.request({ ...action, tool: 'other-tool' }, signal);
  const folder = broker.request(
    { kind: 'workspace', directory: '/other' },
    signal,
  );
  const outsideFile = broker.request(
    {
      kind: 'path',
      directory: '/work',
      fileAccess: { path: '/outside', mode: 'read', scope: 'file' },
    },
    signal,
  );
  const [firstRequest, , folderRequest, fileRequest] = publish.mock.calls.map(
    ([r]) => r,
  );
  broker.answer(firstRequest.id, 'auto');
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  await expect(broker.request(action, signal)).resolves.toBe(true);
  expect(
    publish.mock.calls.map(([r]) => r).filter((r) => r.autoModeEnabled),
  ).toHaveLength(1);
  expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
    status: 'allowed',
    approvalSource: 'auto-mode',
  });
  broker.answer(folderRequest.id, false);
  broker.answer(fileRequest.id, false);
  await expect(folder).resolves.toBe(false);
  await expect(outsideFile).resolves.toBe(false);

  const otherPublish = jest.fn();
  const other = new AgentPermissions(otherPublish);
  const otherAction = other.request(action, signal);
  expect(otherPublish.mock.calls[0][0].status).toBe('pending');
  other.cancel();
  await expect(otherAction).resolves.toBe(false);

  const stopped = new AbortController();
  stopped.abort();
  await expect(broker.request(action, stopped.signal)).resolves.toBe(false);
  broker.cancel();
  const afterCancel = broker.request(action, signal);
  expect(publish.mock.calls.at(-1)?.[0].status).toBe('pending');
  broker.cancel();
  await expect(afterCancel).resolves.toBe(false);
});

test('auto mode cannot be enabled through a folder, cancelled, or unknown request', async () => {
  const publish = jest.fn();
  const broker = new AgentPermissions(publish);
  const signal = new AbortController().signal;
  const folder = broker.request(
    { kind: 'workspace', directory: '/work' },
    signal,
  );
  const id = publish.mock.calls[0][0].id;
  expect(() => broker.answer(id, 'auto')).toThrow('tool action');
  expect(() => broker.answer('unknown', 'auto')).toThrow('no longer active');
  broker.cancel();
  await expect(folder).resolves.toBe(false);
  expect(() => broker.answer(id, 'auto')).toThrow('no longer active');
  const action = broker.request(
    {
      kind: 'action',
      directory: '/work',
      tool: 'bash',
      arguments: { command: 'pwd' },
    },
    signal,
  );
  expect(publish.mock.calls.at(-1)?.[0].status).toBe('pending');
  broker.cancel();
  await expect(action).resolves.toBe(false);
});
