import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeInference,
  startInferenceBridge,
  toPiContext,
} from '../release/app/agent/pi-inference.mjs';

const model = {
  id: 'vendor/vision',
  provider: 'test',
  api: 'openai-completions',
  input: ['text', 'image'],
};
const usage = { input: 10, output: 3, cacheRead: 4, cacheWrite: 2 };
const reply = {
  role: 'assistant',
  model: model.id,
  provider: model.provider,
  api: model.api,
  content: [
    { type: 'text', text: 'Look here', textSignature: 'signed-text' },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'memory',
      arguments: { query: 'task' },
    },
  ],
  usage,
  stopReason: 'toolUse',
};
const request = {
  model: 'pi/test/vendor/vision',
  messages: [
    { role: 'system', content: 'Observe only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is on screen?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
      ],
    },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'memory', parameters: { type: 'object' } },
    },
  ],
};
function runtime(complete = async () => reply) {
  return {
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    completeSimple: complete,
  };
}

test('stateless inference forwards images and tools, returns usage and preserves signed assistant replay', async () => {
  const result = await completeInference(
    runtime(async (selected, context, options) => {
      assert.equal(selected, model);
      assert.equal(context.systemPrompt, 'Observe only.');
      assert.deepEqual(context.messages[0].content[1], {
        type: 'image',
        data: 'YQ==',
        mimeType: 'image/png',
      });
      assert.equal(context.tools[0].name, 'memory');
      assert.equal(options.maxTokens, 123);
      return reply;
    }),
    { ...request, max_tokens: 123 },
  );
  assert.equal(result.usage.prompt_tokens, 16);
  assert.equal(result.usage.completion_tokens, 3);
  assert.equal(
    result.message.tool_calls[0].function.arguments,
    '{"query":"task"}',
  );
  const context = toPiContext(
    [
      ...request.messages,
      result.message,
      { role: 'tool', tool_call_id: 'call-1', content: 'Relevant memory' },
    ],
    model,
  );
  assert.equal(context.messages[1], reply);
  assert.equal(context.messages[2].toolName, 'memory');
  assert.equal(context.messages[2].role, 'toolResult');
});

test('unavailable models, unsupported images/audio, bad tool results and provider errors fail explicitly', async () => {
  await assert.rejects(
    completeInference(runtime(), { ...request, model: 'pi/test/missing' }),
    /unavailable/,
  );
  assert.throws(
    () => toPiContext(request.messages, { ...model, input: ['text'] }),
    /vision-capable/,
  );
  assert.throws(
    () =>
      toPiContext(
        [{ role: 'user', content: [{ type: 'input_audio' }] }],
        model,
      ),
    /input_audio/,
  );
  assert.throws(
    () =>
      toPiContext(
        [{ role: 'tool', tool_call_id: 'unknown', content: 'x' }],
        model,
      ),
    /matching/,
  );
  await assert.rejects(
    completeInference(
      runtime(async () => ({
        ...reply,
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      })),
      request,
    ),
    /Provider unavailable/,
  );
});

test('HTTP bridge authenticates before accessing runtime and keeps parallel requests separate', async () => {
  let calls = 0;
  const bridge = await startInferenceBridge({
    token: 'test-secret',
    getRuntime: async () => {
      calls++;
      return runtime(async (_m, context) => ({
        ...reply,
        content: [{ type: 'text', text: context.messages[0].content[0].text }],
      }));
    },
  });
  try {
    const denied = await fetch(bridge.url, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
    const results = await Promise.all(
      ['sensing', 'suggestion'].map(async (text) => {
        const response = await fetch(bridge.url, {
          method: 'POST',
          headers: { Authorization: 'Bearer test-secret' },
          body: JSON.stringify({
            ...request,
            messages: [{ role: 'user', content: text }],
          }),
        });
        assert.equal(response.status, 200);
        return (await response.json()).message.content[0].text;
      }),
    );
    assert.deepEqual(results, ['sensing', 'suggestion']);
  } finally {
    bridge.close();
  }
});

for (const throws of [false, true]) {
  test(`Gemini retries unsupported MINIMAL with LOW (${throws ? 'thrown' : 'returned'} error)`, async () => {
    const gemini = {
      ...model,
      id: 'gemini-flash-latest',
      provider: 'google',
      api: 'google-generative-ai',
    };
    const calls = [];
    const rt = {
      getModel: () => gemini,
      hasConfiguredAuth: () => true,
      completeSimple: async (_model, _context, options) => {
        calls.push(options);
        if (calls.length === 1) {
          const errorMessage =
            'Thinking level MINIMAL is not supported for this model';
          if (throws) throw new Error(errorMessage);
          return { ...reply, stopReason: 'error', errorMessage };
        }
        return reply;
      },
    };
    await completeInference(rt, {
      ...request,
      model: 'pi/google/gemini-flash-latest',
      reasoning_effort: 'none',
      max_tokens: 128,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].reasoning, undefined);
    assert.equal(calls[1].reasoning, 'low');
    assert.equal(calls[1].maxTokens, 128);
  });
}

test('thinking fallback does not retry other providers or unrelated errors and retries only once', async () => {
  for (const [api, message, expectedCalls] of [
    [
      'openai-completions',
      'Thinking level MINIMAL is not supported for this model',
      1,
    ],
    ['google-generative-ai', 'Invalid API key', 1],
    [
      'google-generative-ai',
      'Thinking level MINIMAL is not supported for this model',
      2,
    ],
  ]) {
    let calls = 0;
    const rt = {
      getModel: () => ({ ...model, api }),
      hasConfiguredAuth: () => true,
      completeSimple: async () => {
        calls++;
        return { ...reply, stopReason: 'error', errorMessage: message };
      },
    };
    await assert.rejects(completeInference(rt, request), { message });
    assert.equal(calls, expectedCalls);
  }
});
