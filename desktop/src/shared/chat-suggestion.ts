/**
 * A proactive suggestion shown as a Coco message in the chat. It is stored
 * with the conversation so it can be folded, reopened, and restored into the
 * tutor's history after a restart.
 */
export interface ChatSuggestion {
  observationId?: string;
  kind: 'content' | 'delegate';
  title: string;
  body?: string;
  prompt?: string;
  copyText: string;
  /** The AI tool a delegate prompt should be opened in. */
  tool?: { id: string; label: string };
  fourDDimension?: string;
  /** One-sentence explanation shown before the action. */
  noticed?: string;
  aiCan?: string;
  why?: string;
  check?: string;
}

const OPTIONAL_TEXT_FIELDS = [
  'observationId',
  'body',
  'prompt',
  'fourDDimension',
  'noticed',
  'aiCan',
  'why',
  'check',
] as const;

/** The suggestion as plain markdown, for copying and for the tutor's history. */
export function chatSuggestionText(suggestion: ChatSuggestion): string {
  const detail =
    suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body;
  const explanation = [
    suggestion.noticed,
    suggestion.aiCan,
    suggestion.why,
    suggestion.check,
  ]
    .filter(Boolean)
    .join(' ');
  return [explanation, `**${suggestion.title}**`, detail || suggestion.copyText]
    .filter(Boolean)
    .join('\n\n');
}

export function parseChatSuggestion(value: unknown): ChatSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'content' && raw.kind !== 'delegate') return null;
  if (typeof raw.title !== 'string' || typeof raw.copyText !== 'string') {
    return null;
  }
  const optional: Partial<ChatSuggestion> = {};
  OPTIONAL_TEXT_FIELDS.forEach((key) => {
    if (typeof raw[key] === 'string') optional[key] = raw[key] as string;
  });
  const tool = raw.tool as Record<string, unknown> | undefined;
  return {
    ...optional,
    kind: raw.kind,
    title: raw.title,
    copyText: raw.copyText,
    ...(tool && typeof tool.id === 'string' && typeof tool.label === 'string'
      ? { tool: { id: tool.id, label: tool.label } }
      : {}),
  };
}
