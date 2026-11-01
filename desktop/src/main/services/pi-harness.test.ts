/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import PiHarness from './pi-harness';
import type { AgentActivity } from '../../shared/agent-execution';

jest.mock('electron', () => ({ app: {} }));
jest.mock('./retry-operation', () => ({
  retryOperation: (operation: () => unknown) => operation(),
}));
let decision: boolean | null;
let approvalCount: number;
let permissionId: string;
let directory: string;
let harness: PiHarness;
const emitted = jest.fn();

beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-grant-')),
  );
  harness = new PiHarness();
  decision = true;
  approvalCount = 0;
  emitted.mockClear();
  // Stop before model/session initialization; the grant must precede HTTP.
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
});
afterEach(async () => {
  await harness.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function run(requestId = 'request') {
  return harness.run({
    requestId,
    sessionId: 'session',
    directory,
    tutorUrl: 'http://localhost',
    token: 'test',
    text: 'hello',
    images: [],
    context: {
      model: 'test',
      scenario: '',
      problem: '',
      user_name: '',
      ai_tools: [],
      memory: '',
      messages: [],
    },
    emit: (event) => {
      emitted(event);
      if (event.type !== 'agent_activity') return;
      const item = (event.activity as AgentActivity[]).find(
        (entry) =>
          entry.kind === 'permission' && entry.request.status === 'pending',
      );
      if (item?.kind !== 'permission') return;
      approvalCount += 1;
      permissionId = item.request.id;
      if (decision !== null) harness.answerPermission(permissionId, decision);
    },
  });
}

test('denied workspace access stops before context requests and grants nothing', async () => {
  decision = false;
  await expect(run()).resolves.toBeUndefined();
  expect(emitted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'done',
      guidance: '',
      activity: [
        expect.objectContaining({
          kind: 'permission',
          request: expect.objectContaining({ status: 'denied' }),
        }),
      ],
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
});

test('grants are reused only for that harness and revocation requires a new approval', async () => {
  await expect(run()).rejects.toThrow('offline');
  expect(harness.hasWorkspaceAccess(directory)).toBe(true);
  expect(new PiHarness().hasWorkspaceAccess(directory)).toBe(false);
  expect(harness.hasWorkspaceAccess(os.tmpdir())).toBe(false);
  await expect(run('second')).rejects.toThrow('offline');
  expect(approvalCount).toBe(1);
  await harness.revokeWorkspaceAccess();
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
  await expect(run('third')).rejects.toThrow('offline');
  expect(approvalCount).toBe(2);
});

test('stopping while workspace approval is pending rejects a late grant', async () => {
  decision = null;
  const pending = run();
  await harness.abort('request');
  expect(() => harness.answerPermission(permissionId, true)).toThrow(
    'no longer active',
  );
  await pending;
  expect(fetch).not.toHaveBeenCalled();
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
});
