import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRuntime } from '../release/app/agent/pi-runtime.mjs';

// Real SDK + real file tools; only the model and Coco's HTTP service are fake.
test('pi executes built-in and Coco tools, resumes its session, and aborts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-pi-test-'));
  let requestCount = 0;
  let hang = false;
  let notifyRequest;
  let lastRequest;
  const tools = [
    'observe_screen',
    'get_user_context',
    'get_recent_observations',
  ].map((name) => ({
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  }));
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/agent/tools/execute') {
      assert.equal(body.name, 'get_user_context');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          count: 1,
          results: [{ text: 'Likes concise replies.' }],
        }),
      );
      return;
    }
    assert.equal(req.url, '/agent/v1/chat/completions');
    lastRequest = body;
    requestCount += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'coco',
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    emit({ role: 'assistant' });
    if (hang) {
      notifyRequest?.();
      return;
    }
    if (requestCount === 1) {
      for (const name of [
        'read',
        'write',
        'edit',
        'bash',
        'ask_user_question',
        ...tools.map((t) => t.function.name),
      ]) {
        assert.ok(
          body.tools.some((t) => t.function.name === name),
          `Missing ${name}`,
        );
      }
      emit({ content: 'I will write the file and check context.' });
      emit({
        tool_calls: [
          {
            index: 2,
            id: 'question-1',
            type: 'function',
            function: {
              name: 'ask_user_question',
              arguments: JSON.stringify({
                questions: [
                  {
                    header: 'Style',
                    question: 'Which style?',
                    options: [
                      { label: 'Brief', description: 'Short answers' },
                      { label: 'Detailed', description: 'Full explanations' },
                    ],
                  },
                ],
              }),
            },
          },
          {
            index: 0,
            id: 'write-1',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                path: 'result.txt',
                content: 'Made by pi',
              }),
            },
          },
          {
            index: 1,
            id: 'memory-1',
            type: 'function',
            function: {
              name: 'get_user_context',
              arguments: '{"query":"preferences"}',
            },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else {
      emit({ content: 'Created result.txt.' });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const context = {
    instructions: 'You are Coco.',
    profile: 'Current task: test',
    model: 'test-model',
    history: [],
    tools,
  };
  const options = {
    cwd: directory,
    sessionId: 'test-session',
    dataDir: directory,
    tutorUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
    context,
  };
  let runtime;
  try {
    runtime = await createRuntime(options);
    const events = [];
    runtime.subscribe((event) => {
      events.push(event);
      if (
        event.type === 'tool_execution_update' &&
        event.toolName === 'ask_user_question' &&
        event.partialResult?.details?.waitingForAnswer
      ) {
        assert.throws(
          () => runtime.answerQuestion(event.toolCallId, { answers: [] }),
          /Answer each/,
        );
        runtime.answerQuestion(event.toolCallId, {
          answers: [{ selected: ['Brief'], text: '' }],
        });
        assert.throws(
          () => runtime.answerQuestion(event.toolCallId, { cancelled: true }),
          /no longer/,
        );
      }
    });
    await runtime.prompt('Create the file.', [], context);
    const requestsBeforeInspect = requestCount;
    const inspected = runtime.getContextSnapshot();
    assert.ok(inspected.estimatedTokens > 0);
    assert.ok(inspected.categories.length > 0);
    assert.equal(inspected.reported.contextWindow, 64000);
    assert.match(JSON.stringify(inspected), /Create the file/);
    assert.equal(requestCount, requestsBeforeInspect, 'inspection must not prompt');
    assert.equal(
      fs.readFileSync(path.join(directory, 'result.txt'), 'utf8'),
      'Made by pi',
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tool_execution_end' &&
          event.toolName === 'get_user_context' &&
          !event.isError,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tool_execution_end' &&
          event.toolName === 'ask_user_question' &&
          event.result?.details?.answers?.[0]?.answer === 'Brief',
      ),
    );
    assert.ok(
      lastRequest.messages.some(
        (message) =>
          message.role === 'tool' && message.content.includes('Brief'),
      ),
    );
    runtime.dispose();
    runtime = await createRuntime(options);
    await runtime.prompt('What did you do?', [], context);
    assert.ok(
      lastRequest.messages.some((message) => message.role === 'tool'),
      'Resumed session retains tool evidence',
    );
    hang = true;
    const started = new Promise((resolve) => {
      notifyRequest = resolve;
    });
    const pending = runtime.prompt('Wait for a long request.', [], context);
    await started;
    await runtime.abort();
    await pending;
  } finally {
    runtime?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
