import { extractSseEvents } from '../main/services/tutor-stream';

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
});
