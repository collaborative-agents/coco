/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import WorkspacePermissions from './workspace-permissions';
import PiHarness from './pi-harness';
import { loadPiRuntime } from './pi-runtime-loader';
import type { AgentActivity } from '../../shared/agent-execution';

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/coco-test', getAppPath: () => '/app' },
}));
jest.mock('./pi-runtime-loader', () => ({ loadPiRuntime: jest.fn() }));
jest.mock('./retry-operation', () => ({
  retryOperation: (operation: () => unknown) => operation(),
}));
let decision: boolean | null;
let approvalCount: number;
let permissionId: string;
let directory: string;
let harness: PiHarness;
let fileCalls: number;
let actionCall: boolean;
let executed: number;
let approvalShown: () => void;
const emitted = jest.fn();

beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coco-grant-')),
  );
  harness = new PiHarness();
  decision = true;
  approvalCount = 0;
  fileCalls = 0;
  actionCall = false;
  executed = 0;
  approvalShown = () => {};
  emitted.mockClear();
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      model: 'test',
      instructions: '',
      profile: '',
      history: [],
      tools: [],
      history_length: 0,
    }),
  } as Response);
  jest.mocked(loadPiRuntime).mockResolvedValue({
    createRuntime: async (options: {
      requestWorkspaceAccess: () => Promise<boolean>;
      requestApproval: (action: unknown) => Promise<boolean>;
    }) => ({
      subscribe: () => () => {},
      dispose() {},
      abort: async () => {},
      setHistoryLength() {},
      prompt: async () => {
        if (actionCall) {
          const allowed = await options.requestApproval({
            tool: 'bash',
            directory,
            arguments: { command: 'pwd' },
          });
          if (!allowed) throw new Error('Permission denied');
          executed++;
        }
        await Promise.all(
          Array.from({ length: fileCalls }, async () => {
            if (!(await options.requestWorkspaceAccess()))
              throw new Error('Permission denied');
            executed++;
          }),
        );
      },
    }),
  });
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
      approvalCount++;
      permissionId = item.request.id;
      approvalShown();
      if (decision !== null) harness.answerPermission(permissionId, decision);
    },
  });
}

test('a greeting completes without a workspace prompt or grant; a later file call asks', async () => {
  await run();
  expect(approvalCount).toBe(0);
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
  fileCalls = 1;
  await run('later');
  expect(approvalCount).toBe(1);
  expect(executed).toBe(1);
});

test('denied workspace access prevents file execution', async () => {
  fileCalls = 1;
  decision = false;
  await expect(run()).rejects.toThrow('Permission denied');
  expect(executed).toBe(0);
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
});

test('concurrent file calls share one prompt and reuse the grant on later turns', async () => {
  fileCalls = 2;
  await run();
  expect(approvalCount).toBe(1);
  expect(executed).toBe(2);
  await run('second');
  expect(approvalCount).toBe(1);
  await harness.revokeWorkspaceAccess();
  await run('third');
  expect(approvalCount).toBe(2);
});

test('stopping a deferred workspace prompt rejects late approval and does not grant access', async () => {
  fileCalls = 1;
  decision = null;
  const shown = new Promise<void>((resolve) => {
    approvalShown = resolve;
  });
  const pending = run();
  await shown;
  await harness.abort('request');
  expect(() => harness.answerPermission(permissionId, true)).toThrow(
    'no longer active',
  );
  await pending;
  expect(executed).toBe(0);
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
});

test('saved workspace grants survive runtime disposal and a fresh store', async () => {
  const store = new WorkspacePermissions(directory);
  harness = new PiHarness(store);
  fileCalls = 1;
  await run();
  expect(approvalCount).toBe(1);
  await harness.dispose();
  harness = new PiHarness(new WorkspacePermissions(directory));
  await run('new-chat');
  expect(approvalCount).toBe(1);
  await harness.revokeWorkspaceAccess(directory);
  await run('after-revoke');
  expect(approvalCount).toBe(2);
});

test('commands use their action approval without a redundant workspace prompt', async () => {
  actionCall = true;
  await run();
  expect(approvalCount).toBe(1);
  const events = emitted.mock.calls.flatMap(([event]) => event.activity ?? []);
  expect(
    events.some(
      (item) => item.kind === 'permission' && item.request.kind === 'workspace',
    ),
  ).toBe(false);
  expect(executed).toBe(1);
  expect(harness.hasWorkspaceAccess(directory)).toBe(false);
});
