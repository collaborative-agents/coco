import PiEventTranslator from './pi-events';
import { parseAgentActivity } from '../../shared/agent-execution';

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
