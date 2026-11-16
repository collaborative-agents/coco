/** @jest-environment node */
import registerReactiveChat from './reactive-chat';
import ensureChatConversation from './chat-conversation';

jest.mock('electron-log', () => ({ warn: jest.fn(), error: jest.fn() }));
jest.mock('./conversation-store', () => ({
  readConversations: () => [],
  restorableMessages: () => [],
}));
jest.mock('./model-config-store', () => ({
  readModelConfiguration: () => null,
}));
jest.mock('./services/pi-provider', () => ({
  readPiConnection: () => ({
    mode: 'native',
    provider: 'test',
    model: 'model',
  }),
}));
jest.mock('./services/chat-visibility', () => ({
  __esModule: true,
  default: async () => false,
}));
jest.mock('./services/agent-progress-reminder', () => ({
  __esModule: true,
  default: jest.fn(() => ({ update: jest.fn(), dispose: jest.fn() })),
}));

function setup() {
  let sessionId: string | null = null;
  const run = jest.fn(async () => {});
  const scheduler = {
    beginInteractiveInference: jest.fn(),
    endInteractiveInference: jest.fn(),
  };
  const streams = {
    begin: jest.fn(),
    accept: jest.fn(),
    flush: jest.fn(),
    finish: jest.fn(),
  };
  const runs = {
    begin: jest.fn(),
    finish: jest.fn(),
    get: () => ({ run }),
    requests: new Map(),
  };
  const handlers = new Map<string, Function>();
  const deps = {
    ipc: {
      handle: (name: string, fn: Function) => handlers.set(name, fn),
      removeHandler: jest.fn(),
    },
    session: () => ({ id: sessionId, model: null, label: 'Help' }),
    chat: () => null,
    avatar: () => null,
    avatarHidden: () => false,
    scheduler: () => scheduler,
    runs,
    streams,
    token: 'test',
    profile: () => ({ scenario: '', userName: '', aiTools: [] }),
    memory: () => '',
    directory: () => '/tmp',
    approvalRules: () => ({}),
    workshop: () => ({ get: () => null }),
    skills: () => ({ runtimeSkills: () => [] }),
    usage: () => ({ observe: jest.fn() }),
    activate: jest.fn(),
  };
  registerReactiveChat(
    deps as unknown as Parameters<typeof registerReactiveChat>[0],
  );
  const open = () =>
    ensureChatConversation({
      current: () => sessionId,
      latest: () => null,
      draftId: () => 'draft',
      select: (id) => {
        sessionId = id;
      },
    });
  return { open, handlers, run, scheduler, streams, runs, deps };
}

it.each(['send-chat-message', 'send-audio-message'])(
  'accepts the first %s after opening chat without +New',
  async (channel) => {
    const test = setup();
    test.open();
    const input =
      channel === 'send-audio-message'
        ? { audioData: 'audio' }
        : { userText: 'Hello' };
    expect(
      await test.handlers.get(channel)!({}, { requestId: 'first', ...input }),
    ).toEqual({ streamed: true });
    expect(test.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'draft',
        context: expect.objectContaining({ model: 'pi/test/model' }),
      }),
    );
    expect(test.deps.activate).toHaveBeenCalledWith('draft');
    expect(test.scheduler.endInteractiveInference).toHaveBeenCalledTimes(1);
    expect(test.runs.finish).toHaveBeenCalledWith('first');
  },
);

it('releases the run and personalization pause when the agent fails', async () => {
  const test = setup();
  test.open();
  test.run.mockRejectedValueOnce(new Error('Provider unavailable'));
  expect(
    await test.handlers.get('send-chat-message')!(
      {},
      { requestId: 'failed', userText: 'Hello' },
    ),
  ).toEqual({ error: 'Provider unavailable' });
  expect(test.streams.accept).toHaveBeenCalledWith(
    'failed',
    expect.objectContaining({ type: 'error', error: 'Provider unavailable' }),
  );
  expect(test.streams.finish).toHaveBeenCalledWith('failed');
  expect(test.runs.finish).toHaveBeenCalledWith('failed');
  expect(test.scheduler.endInteractiveInference).toHaveBeenCalledTimes(1);
});
