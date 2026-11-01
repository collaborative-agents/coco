import PiEventTranslator from './pi-events';
import { parseAgentActivity } from '../../shared/agent-execution';

test('permission cards survive tool updates and serialize with their latest decision', () => {
  const emit = jest.fn();
  const translator = new PiEventTranslator(emit);
  const request = {
    id: 'permission',
    kind: 'workspace' as const,
    directory: '/work',
    status: 'pending' as const,
  };
  translator.permission(request);
  expect(parseAgentActivity(emit.mock.calls.at(-1)?.[0].activity)).toEqual([
    { kind: 'permission', request },
  ]);
  translator.permission({ ...request, status: 'allowed' });
  translator.handle({
    type: 'tool_execution_start',
    toolCallId: 'tool',
    toolName: 'read',
    args: { path: 'file' },
  });
  translator.finish(true);
  expect(translator.activity[0]).toEqual({
    kind: 'permission',
    request: { ...request, status: 'allowed' },
  });
  expect(translator.activity).toHaveLength(2);
});

test('keeps intermediate text, live output, and final answer in execution order', () => {
  const emit = jest.fn();
  const translator = new PiEventTranslator(emit);
  translator.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Checking files.' },
  });
  translator.handle({
    type: 'tool_execution_start',
    toolCallId: '1',
    toolName: 'bash',
    args: { command: 'pwd' },
  });
  translator.handle({
    type: 'tool_execution_update',
    toolCallId: '1',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: '/work' }] },
  });
  expect(translator.activity[0]).toEqual({
    kind: 'message',
    text: 'Checking files.',
  });
  expect(translator.text).toBe('');
  expect(translator.calls.get('1')?.result?.output).toBe('/work');
  translator.handle({
    type: 'tool_execution_end',
    toolCallId: '1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: '/work' }] },
    isError: false,
  });
  translator.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Finished.' },
  });
  expect(translator.finish(false)).toBe('Finished.');
  expect(translator.activity).toHaveLength(2);
  expect(translator.calls.get('1')?.status).toBe('completed');
});

test('marks interrupted tools and retains completed work when stopped', () => {
  const translator = new PiEventTranslator(jest.fn());
  translator.handle({
    type: 'tool_execution_start',
    toolCallId: '1',
    toolName: 'bash',
    args: {},
  });
  expect(translator.finish(true)).toBe('Stopped.');
  expect(translator.calls.get('1')?.result?.error).toBe('Stopped');
});

test('surfaces provider errors instead of presenting an empty success', () => {
  const translator = new PiEventTranslator(jest.fn());
  translator.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Provider failed',
    },
  });
  expect(() => translator.finish(false)).toThrow('Provider failed');
});

test('restored activity never leaves tools looking like they are still running', () => {
  expect(
    parseAgentActivity(
      [
        {
          kind: 'tool',
          call: { id: '1', name: 'bash', arguments: {}, status: 'running' },
        },
      ],
      true,
    ),
  ).toEqual([
    {
      kind: 'tool',
      call: {
        id: '1',
        name: 'bash',
        arguments: {},
        status: 'error',
        result: { error: 'Interrupted when Coco closed.' },
      },
    },
  ]);
});

test('totals all calls including cached input, without treating absent usage as zero', () => {
  const translator = new PiEventTranslator(jest.fn());
  expect(translator.metrics('model').prompt_tokens).toBeUndefined();
  translator.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 2 },
    },
  });
  translator.handle({
    type: 'message_end',
    message: { role: 'assistant', usage: { input: 40, output: 6 } },
  });
  expect(translator.metrics('model')).toMatchObject({
    prompt_tokens: 75,
    completion_tokens: 8,
    total_tokens: 83,
  });
  translator.handle({ type: 'message_end', message: { role: 'assistant' } });
  expect(translator.metrics('model').prompt_tokens).toBeUndefined();
});
