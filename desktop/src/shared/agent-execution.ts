import type { TutorToolCall } from '../renderer/components/observation-types';

export type AgentActivity =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; call: TutorToolCall };

export interface AgentWorkspace {
  directory: string;
}

/** Preserve only recognized activity records in persisted chat snapshots. */
export function parseAgentActivity(
  value: unknown,
  interrupted = false,
): AgentActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): AgentActivity[] => {
    if (item?.kind === 'message' && typeof item.text === 'string')
      return [{ kind: 'message', text: item.text }];
    const call = item?.call;
    if (
      item?.kind !== 'tool' ||
      !call ||
      typeof call.id !== 'string' ||
      typeof call.name !== 'string' ||
      !['running', 'completed', 'error'].includes(call.status) ||
      !call.arguments ||
      typeof call.arguments !== 'object'
    )
      return [];
    return [
      {
        kind: 'tool',
        call:
          interrupted && call.status === 'running'
            ? {
                ...call,
                status: 'error',
                result: { error: 'Interrupted when Coco closed.' },
              }
            : call,
      },
    ];
  });
}
