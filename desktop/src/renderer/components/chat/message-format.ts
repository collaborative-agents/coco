import type { Guidance, ChatMessage } from './types';

/** Scan for the first balanced {...} block, respecting strings and escapes. */
function extractJsonObject(text: string): string | null {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (!inString) {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/** LLMs embed LaTeX (\frac …) in JSON strings unescaped — repair before parse. */
function repairJsonEscapes(text: string): string {
  const structural = new Set(['"', '\\', '/']);
  const ambiguous = new Set(['b', 'f', 'n', 'r', 't']);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const nxt = text[i + 1];
      if (structural.has(nxt)) {
        out.push(text[i], nxt);
        i += 2;
        continue;
      }
      if (
        nxt === 'u' &&
        i + 5 < text.length &&
        /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))
      ) {
        out.push(text.slice(i, i + 6));
        i += 6;
        continue;
      }
      if (ambiguous.has(nxt)) {
        const after = i + 2 < text.length ? text[i + 2] : '';
        if (/[a-zA-Z]/.test(after)) {
          out.push('\\\\');
          i += 1;
          continue;
        }
        out.push(text[i], nxt);
        i += 2;
        continue;
      }
      out.push('\\\\');
      i += 1;
      continue;
    }
    out.push(text[i]);
    i += 1;
  }
  return out.join('');
}

function parseCompetency(value: unknown): Guidance['competency'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ['delegation', 'description', 'discernment', 'diligence'].includes(
    normalized,
  )
    ? (normalized as Guidance['competency'])
    : undefined;
}

// Coaching can follow an ordinary answer. Find a standalone envelope outside
// fenced code so examples in Markdown remain visible and the answer is retained.
function guidanceOffset(raw: string): number {
  let offset = 0;
  let fence: string | null = null;
  for (const line of raw.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        line.slice(marker[0].length).trim() === ''
      )
        fence = null;
    } else if (marker) {
      fence = marker[1];
    } else {
      const candidate = line.trimStart();
      if (
        line.length - candidate.length <= 3 &&
        (/^<guidance\s*>/i.test(candidate) ||
          (candidate && '<guidance>'.startsWith(candidate.toLowerCase())))
      )
        return offset + line.length - candidate.length;
    }
    offset += line.length + 1;
  }
  return -1;
}

function parseXmlGuidance(raw: string): Guidance | null {
  const offset = guidanceOffset(raw);
  if (offset < 0) return null;
  const prefix = raw.slice(0, offset).trimEnd();
  const source = raw.slice(offset).trimStart();
  const opening = '<guidance>';
  if (source && opening.startsWith(source.toLowerCase()))
    return { text: prefix };
  if (!/^<guidance\s*>/i.test(source)) return null;
  const body = source.replace(/^<guidance\s*>/i, '');
  const boundary = body.search(
    /<\/guidance\s*>|<(?:four_d_dimension|teaching_depth|example_prompt|visualization|html_code)\s*>/i,
  );
  let text = boundary < 0 ? body : body.slice(0, boundary);
  // Streaming may stop midway through a closing tag or a metadata field.
  const tail = text.lastIndexOf('<');
  if (tail >= 0) {
    const fragment = text.slice(tail).toLowerCase();
    if (
      [
        '</guidance>',
        '<four_d_dimension>',
        '<teaching_depth>',
        '<example_prompt>',
        '<visualization>',
        '<html_code>',
      ].some((tag) => tag.startsWith(fragment))
    ) {
      text = text.slice(0, tail);
    }
  }
  const example = source
    .match(/<example_prompt\s*>([\s\S]*?)<\/example_prompt\s*>/i)?.[1]
    .trim();
  const viz = source
    .match(/<html_code\s*>([\s\S]*?)<\/html_code\s*>/i)?.[1]
    .trim();
  const competency = parseCompetency(
    source.match(
      /<four_d_dimension\s*>([\s\S]*?)<\/four_d_dimension\s*>/i,
    )?.[1],
  );
  return {
    ...(competency ? { competency } : {}),
    text: [prefix, text.trim()].filter(Boolean).join('\n\n'),
    ...(text.trim() && (prefix || competency)
      ? { mainText: prefix, coaching: text.trim() }
      : {}),
    examplePrompt:
      example && example.toLowerCase() !== 'not applicable' ? example : null,
    vizCode: viz || null,
  };
}

export function parseGuidance(raw: string): Guidance {
  const xml = parseXmlGuidance(raw);
  if (xml) return xml;
  const tryParse = (s: string): any => {
    try {
      return JSON.parse(s);
    } catch {
      try {
        return JSON.parse(repairJsonEscapes(s));
      } catch {
        return null;
      }
    }
  };
  let obj: any = tryParse(raw.trim());
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence) obj = tryParse(fence[1].trim());
  }
  if (!obj) {
    const block = extractJsonObject(raw);
    if (block) obj = tryParse(block);
  }
  if (obj && typeof obj === 'object') {
    const text = obj.guidance ?? obj['Text guidance'] ?? '';
    const example = obj.example_prompt ?? obj.examplePrompt ?? null;
    const viz = obj.visualization_code ?? obj.visualizationCode ?? null;
    const nested = parseXmlGuidance(String(text || raw));
    const competency =
      parseCompetency(obj.four_d_dimension) ?? nested?.competency;
    const parsedText = nested?.text ?? String(text || raw);
    return {
      ...(competency ? { competency } : {}),
      text: parsedText,
      ...(nested?.coaching
        ? { mainText: nested.mainText, coaching: nested.coaching }
        : competency
          ? { mainText: '', coaching: parsedText }
          : {}),
      examplePrompt:
        example && String(example).toLowerCase() !== 'not applicable'
          ? String(example)
          : null,
      vizCode: viz ? String(viz) : null,
    };
  }
  return { text: raw };
}

export function copyableMessageText(message: ChatMessage): string {
  if (message.role === 'tutor' && !message.isError) {
    return parseGuidance(message.text).text;
  }
  return message.text;
}

export function messageCopyKey(message: ChatMessage, index: number): string {
  return `${message.role}:${message.id ?? message.ts ?? index}`;
}

export const makeMessageId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function formatMetricTokens(n?: number): string {
  if (typeof n !== 'number') return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function formatMetricLatency(ms?: number): string {
  if (typeof ms !== 'number') return '0s';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}
