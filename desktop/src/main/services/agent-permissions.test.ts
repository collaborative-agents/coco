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
