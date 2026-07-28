import {
  consumeTutorStream,
  extractSseEvents,
} from '../main/services/tutor-stream';

describe('tutor SSE parsing', () => {
  it('parses complete events and retains a split event', () => {
    const first = extractSseEvents(
      'data: {"type":"text_delta","text":"Hello "}\n\n'
        + 'data: {"type":"text_delta","text":"wor',
    );

    expect(first.events).toEqual([
      { type: 'text_delta', text: 'Hello ' },
    ]);
    expect(first.remainder).toBe(
      'data: {"type":"text_delta","text":"wor',
    );

    const second = extractSseEvents(`${first.remainder}ld"}\r\n\r\n`);
    expect(second.events).toEqual([
      { type: 'text_delta', text: 'world' },
    ]);
    expect(second.remainder).toBe('');
  });

  it('joins multiple data lines in one event', () => {
    const parsed = extractSseEvents(
      'data: {"type":"done",\ndata: "guidance":"ok"}\n\n',
    );

    expect(parsed.events).toEqual([{ type: 'done', guidance: 'ok' }]);
  });

  it('ignores keep-alive comments', () => {
    const parsed = extractSseEvents(
      ': keep-alive\n\ndata: {"type":"done","guidance":"ok"}\n\n',
    );

    expect(parsed.events).toEqual([{ type: 'done', guidance: 'ok' }]);
  });

  it('aborts a stream after inactivity', async () => {
    jest.useFakeTimers();
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (_url, init) => ({
      ok: true,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        }),
      },
    })) as jest.Mock;

    try {
      const pending = consumeTutorStream(
        'http://tutor.test/stream',
        {},
        jest.fn(),
        undefined,
        { idleMs: 100, hardMs: 1_000 },
      );
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(101);

      await expect(pending).rejects.toEqual(
        expect.objectContaining({ kind: 'idle' }),
      );
    } finally {
      global.fetch = originalFetch;
      jest.useRealTimers();
    }
  });
});
