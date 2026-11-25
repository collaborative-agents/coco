import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../release/app/agent/pi-runtime.mjs';

test('execution sees history screenshots as images without an extra approval', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'coco-history-tool-'),
  );
  fs.mkdirSync(path.join(directory, 'pi'));
  fs.writeFileSync(
    path.join(directory, 'pi/browser.json'),
    '{"enabled":false}',
  );
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
  const requests = [];
  let searches = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.url === '/agent/tools/execute') {
      searches++;
      assert.equal(body.name, 'search_screen_history');
      assert.equal(body.arguments.query, 'internship end date');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          count: 1,
          matches: [{ time: '2026-11-24 11:14:19', score: 0.5 }],
          images: [{ mimeType: 'image/png', data: png }],
        }),
      );
      return;
    }
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'coco',
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (requests.length === 1) {
      emit(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'history-1',
              type: 'function',
              function: {
                name: 'search_screen_history',
                arguments: '{"query":"internship end date"}',
              },
            },
          ],
        },
        'tool_calls',
      );
    } else {
      emit(
        { role: 'assistant', content: 'The email gives the end date.' },
        'stop',
      );
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  try {
    const context = {
      model: 'test',
      instructions: 'You are Coco.',
      profile: '',
      history: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_screen_history',
            description: 'Search earlier screens',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      ],
    };
    runtime = await createRuntime({
      cwd: directory,
      dataDir: directory,
      sessionId: 'history',
      tutorUrl: `http://127.0.0.1:${server.address().port}`,
      token: 'test-token',
      context,
      requestApproval: async () => {
        throw new Error('History lookup must not request shell approval');
      },
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.prompt('When does my internship end?', [], context);
    assert.equal(searches, 1);
    assert.equal(requests.length, 2);
    const finished = events.find(
      (event) =>
        event.type === 'tool_execution_end' &&
        event.toolName === 'search_screen_history',
    );
    assert.ok(finished);
    assert.equal(finished.isError, false);
    assert.deepEqual(finished.result.content[1], {
      type: 'image',
      mimeType: 'image/png',
      data: png,
    });
    assert.equal(finished.result.details.images, undefined);
    assert.ok(!finished.result.content[0].text.includes(png));
    // The real SDK must carry image evidence into the follow-up model call.
    assert.ok(
      JSON.stringify(requests[1].messages).includes(
        `data:image/png;base64,${png}`,
      ),
    );
    assert.ok(
      JSON.stringify(requests[1].messages).includes('2026-11-24 11:14:19'),
    );
  } finally {
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
