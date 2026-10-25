// Stateless inference only: no AgentSession, file tools, or conversation storage.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function contentBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new Error('Invalid message content.');
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image_url') {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(
        block.image_url?.url,
      );
      if (!match) throw new Error('Pi inference requires inline image data.');
      return { type: 'image', mimeType: match[1], data: match[2] };
    }
    throw new Error(`Pi inference does not support ${block.type} input.`);
  });
}

export function toPiContext(messages, model, tools) {
  if (!Array.isArray(messages) || !messages.length)
    throw new Error('Messages are required.');
  const system = [];
  const converted = [];
  const toolNames = new Map();
  for (const message of messages) {
    const content = contentBlocks(message.content);
    if (
      content.some((block) => block.type === 'image') &&
      !model.input.includes('image')
    )
      throw new Error(
        'Selected Pi model does not support images. Choose a vision-capable model.',
      );
    const timestamp = Date.now();
    if (message.role === 'system' || message.role === 'developer') {
      if (content.some((block) => block.type !== 'text'))
        throw new Error('System content must be text.');
      system.push(content.map((block) => block.text).join('\n'));
    } else if (message.role === 'user') {
      converted.push({ role: 'user', content, timestamp });
    } else if (message.role === 'assistant') {
      const calls = (message.tool_calls || []).map((call) => {
        toolNames.set(call.id, call.function.name);
        return {
          type: 'toolCall',
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
        };
      });
      const original = message.pi_message;
      converted.push(
        original?.role === 'assistant' &&
          original.provider === model.provider &&
          original.model === model.id
          ? original
          : {
              role: 'assistant',
              content: [...content, ...calls],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: calls.length ? 'toolUse' : 'stop',
              timestamp,
            },
      );
    } else if (message.role === 'tool') {
      const toolName = toolNames.get(message.tool_call_id);
      if (!toolName)
        throw new Error('Tool result has no matching assistant tool call.');
      converted.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id,
        toolName,
        content,
        isError: false,
        timestamp,
      });
    } else throw new Error(`Unsupported message role: ${message.role}`);
  }
  return {
    systemPrompt: system.join('\n\n'),
    messages: converted,
    ...(tools?.length
      ? {
          tools: tools.map((tool) => {
            if (tool.type !== 'function' || !tool.function?.name)
              throw new Error('Only function tools are supported.');
            return {
              name: tool.function.name,
              description: tool.function.description || '',
              parameters: tool.function.parameters || {
                type: 'object',
                properties: {},
              },
            };
          }),
        }
      : {}),
  };
}

export async function completeInference(runtime, request, signal) {
  if (
    typeof request.model !== 'string' ||
    !/^pi\/[^/]+\/.+/.test(request.model)
  )
    throw new Error('Choose a Pi provider and model.');
  const [, provider, ...parts] = request.model.split('/');
  const model = runtime.getModel(provider, parts.join('/'));
  if (!model)
    throw new Error(
      'Selected Pi model is unavailable. Refresh models in settings.',
    );
  if (!runtime.hasConfiguredAuth(provider))
    throw new Error('Sign in to the selected Pi provider in settings.');
  if (
    request.tool_choice != null &&
    !['auto', 'none'].includes(request.tool_choice)
  )
    throw new Error('Pi inference supports auto or none tool choice.');
  const context = toPiContext(request.messages, model, request.tools);
  const options = { signal, timeoutMs: 120_000, maxRetries: 1 };
  if (request.temperature != null) options.temperature = request.temperature;
  if (request.max_tokens != null) options.maxTokens = request.max_tokens;
  if (request.top_p != null) {
    if (
      ![
        'openai-completions',
        'openai-responses',
        'azure-openai-responses',
      ].includes(model.api)
    )
      throw new Error(
        'This Pi model does not support top_p through the shared inference route.',
      );
    options.samplingParams = { top_p: request.top_p };
  }
  if (request.tool_choice != null) options.toolChoice = request.tool_choice;
  if (
    request.reasoning_effort &&
    !['none', 'default'].includes(request.reasoning_effort)
  )
    options.reasoning = request.reasoning_effort;
  const reply = await runtime.completeSimple(model, context, options);
  if (['error', 'aborted', 'deferred', 'pending'].includes(reply.stopReason))
    throw new Error(reply.errorMessage || `Pi inference ${reply.stopReason}.`);
  return {
    message: {
      role: 'assistant',
      content: reply.content
        .filter((p) => p.type === 'text')
        .map((p) => ({ type: 'text', text: p.text })),
      tool_calls: reply.content
        .filter((p) => p.type === 'toolCall')
        .map((p) => ({
          id: p.id,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.arguments) },
        })),
      pi_message: reply,
    },
    usage: {
      prompt_tokens:
        reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
      completion_tokens: reply.usage.output,
      cache_read_input_tokens: reply.usage.cacheRead,
      cache_creation_input_tokens: reply.usage.cacheWrite,
    },
  };
}

export async function startInferenceBridge({ token, getRuntime }) {
  if (!token) throw new Error('An inference bridge credential is required.');
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const authorization = Buffer.from(req.headers.authorization || '');
    const send = (status, body) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    };
    if (
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    ) {
      send(401, { error: 'Invalid inference bridge credential.' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/completion') {
      send(404, { error: 'Unknown inference route.' });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
      send(504, { error: 'Pi inference timed out.' });
    }, 125_000);
    res.on('close', () => controller.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          send(413, { error: 'Inference request too large.' });
          return;
        }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await completeInference(
        await getRuntime(),
        request,
        controller.signal,
      );
      if (!controller.signal.aborted) send(200, result);
    } catch (error) {
      if (!controller.signal.aborted)
        send(502, { error: error.message || 'Pi inference failed.' });
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 130_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/completion`,
    close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}
