import type { TutorToolCall } from '../renderer/components/observation-types';

export interface CommandApprovalRule {
  id: string;
  directory: string;
  prefix: string[];
}

export interface FileAccess {
  path: string;
  scope: 'file' | 'directory';
  mode: 'read' | 'write';
}
export interface WorkspacePermissionRule {
  id: string;
  directory: string;
  kind: 'workspace' | 'path';
  fileAccess?: FileAccess;
}

export interface PermissionRequest {
  suggestedPrefix?: string[];
  approvalSource?: 'saved-rule';
  id: string;
  kind: 'workspace' | 'action' | 'path';
  fileAccess?: FileAccess;
  directory: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
}

export type AgentActivity =
  | { kind: 'message'; text: string }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'tool'; call: TutorToolCall };

export interface AgentWorkspace {
  directory: string;
  accessGranted: boolean;
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
    if (item?.kind === 'permission') {
      const { request } = item;
      if (
        !request ||
        typeof request.id !== 'string' ||
        !['workspace', 'action', 'path'].includes(request.kind) ||
        typeof request.directory !== 'string' ||
        !['pending', 'allowed', 'denied', 'cancelled'].includes(
          request.status,
        ) ||
        (request.kind === 'path' &&
          (!request.fileAccess ||
            typeof request.fileAccess.path !== 'string' ||
            !['file', 'directory'].includes(request.fileAccess.scope) ||
            !['read', 'write'].includes(request.fileAccess.mode))) ||
        (request.kind === 'action' &&
          (typeof request.tool !== 'string' ||
            !request.arguments ||
            typeof request.arguments !== 'object'))
      )
        return [];
      return [
        {
          kind: 'permission',
          request: {
            ...request,
            status:
              interrupted && request.status === 'pending'
                ? 'cancelled'
                : request.status,
          },
        },
      ];
    }
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
