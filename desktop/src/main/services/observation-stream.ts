import log from 'electron-log';

export interface LLMCallMetrics {
  call_id?: string;
  operation?: string | null;
  model?: string;
  provider?: string;
  modality?: 'llm' | 'vlm';
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
}

export interface ObservationEvent {
  type: string;
  observation?: string;
  /** Coarse status label emitted by AiTutoringProcessor (e.g. 'task_suggested', 'task_complete'). */
  status?: string;
  ts?: number;
  scenario?: string;
  /** Short description of the user's inferred task — present on all non-ready events. */
  task_label?: string;
  /** Stable id for this observation; used to key the instant-suggestion cache and feedback joins. */
  observation_id?: string;
  /** Screenshot paths associated with this observation, when retained by sensing. */
  image_paths?: string[];
  /** "yes"/"no" — whether the user is applying AI output (discernment opportunities). */
  applying_ai_output?: string;
  llm_metrics?: LLMCallMetrics;
}

interface StartOpts {
  url: string;
  onEvent: (event: ObservationEvent) => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5_000;

let stopped = false;
let activeAbort: AbortController | null = null;
let backoffMs = MIN_BACKOFF_MS;

function parseSseChunk(buffer: string): {
  events: string[];
  remainder: string;
} {
  const events: string[] = [];
  let idx: number;
  let rest = buffer;
  // SSE event boundary is a blank line — \n\n or \r\n\r\n.
  while (
    (idx = rest.indexOf('\n\n')) !== -1 ||
    (idx = rest.indexOf('\r\n\r\n')) !== -1
  ) {
    const sep = rest.startsWith('\r\n\r\n', idx) ? 4 : 2;
    events.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep);
  }
  return { events, remainder: rest };
}

function extractDataPayload(rawEvent: string): string | null {
  // Each SSE event is one or more `data:` lines plus comments. Concatenate
  // all data lines per spec; ignore comments (lines starting with `:`) and
  // unrelated fields (`event:`, `id:`, `retry:`).
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

async function consumeStream(
  url: string,
  onEvent: (event: ObservationEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE handshake failed: HTTP ${res.status}`);
  }
  log.info(`[ObservationStream] connected to ${url}`);
  backoffMs = MIN_BACKOFF_MS;

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, remainder } = parseSseChunk(buffer);
    buffer = remainder;
    for (const raw of events) {
      const payload = extractDataPayload(raw);
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as ObservationEvent;
        onEvent(parsed);
      } catch (e) {
        log.warn(`[ObservationStream] dropped malformed event:`, payload);
      }
    }
  }
}

export function startObservationStream({ url, onEvent }: StartOpts) {
  // Guard against concurrent double-starts (e.g. two startObserver() calls).
  // A running loop has activeAbort set while a connection is open; between
  // retries it is null but stopped is false, so check both.
  if (!stopped && activeAbort !== null) {
    log.warn('[ObservationStream] already running — ignoring duplicate start');
    return;
  }
  stopped = false;

  const loop = async () => {
    while (!stopped) {
      const ctrl = new AbortController();
      activeAbort = ctrl;
      try {
        await consumeStream(url, onEvent, ctrl.signal);
        // Stream ended cleanly — server closed. Treat like a transient drop.
        log.info('[ObservationStream] stream ended; will reconnect');
      } catch (err) {
        if (stopped) return;
        // Node's `fetch()` reports connection failures as a generic
        // "fetch failed" and stashes the real reason on `.cause`.
        // Surface it (ECONNREFUSED, ENOTFOUND, …) so we can tell whether
        // sensing-server isn't running vs. is up but rejecting the request.
        const e = err as Error & { cause?: unknown };
        const cause = (e?.cause as { code?: string; message?: string }) || {};
        const detail = cause.code || cause.message || e?.message || String(err);
        log.warn(
          `[ObservationStream] connection error (retrying in ${backoffMs}ms): ${detail}`,
        );
      } finally {
        activeAbort = null;
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  };

  loop().catch((e) => log.error('[ObservationStream] loop crashed:', e));
}

export function stopObservationStream() {
  stopped = true;
  activeAbort?.abort();
  activeAbort = null;
}
