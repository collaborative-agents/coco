export interface TutorStreamEvent {
  type:
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'text_delta'
    | 'done'
    | 'error';
  [key: string]: unknown;
}

function extractSseEvents(buffer: string): {
  events: TutorStreamEvent[];
  remainder: string;
} {
  const events: TutorStreamEvent[] = [];
  let remainder = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(remainder);
    if (!match || match.index === undefined) break;
    const raw = remainder.slice(0, match.index);
    remainder = remainder.slice(match.index + match[0].length);
    const payload = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload) continue;
    events.push(JSON.parse(payload) as TutorStreamEvent);
  }
  return { events, remainder };
}

export async function consumeTutorStream(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: TutorStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Tutor stream failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const parsed = extractSseEvents(buffer);
    buffer = parsed.remainder;
    parsed.events.forEach(onEvent);
    if (done) break;
  }
}

export { extractSseEvents };
