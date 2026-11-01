import { randomUUID } from 'crypto';
import CommandApprovalRules, { commandPrefix } from './command-approval-rules';
import type { PermissionRequest } from '../../shared/agent-execution';

export interface ActionApproval {
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  directory: string;
}

/** Trusted pending requests live in main, never in renderer or model state. */
export default class AgentPermissions {
  private readonly pending = new Map<
    string,
    {
      finish: (status: PermissionRequest['status']) => void;
      remember: () => void;
    }
  >();

  private readonly publish: (request: PermissionRequest) => void;

  constructor(
    publish: (request: PermissionRequest) => void,
    private readonly rules?: CommandApprovalRules,
  ) {
    this.publish = publish;
  }

  request(
    input: Omit<PermissionRequest, 'id' | 'status'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const request: PermissionRequest = {
      ...structuredClone(input),
      id: randomUUID(),
      status: 'pending',
    };
    if (input.kind === 'action' && input.tool === 'bash' && this.rules) {
      request.suggestedPrefix =
        commandPrefix(input.arguments?.command) ?? undefined;
      if (this.rules.matches(input.directory, input.arguments?.command)) {
        this.publish({
          ...request,
          status: 'allowed',
          approvalSource: 'saved-rule',
        });
        return Promise.resolve(true);
      }
    }
    return new Promise((resolve) => {
      const cancel = () => this.pending.get(request.id)?.finish('cancelled');
      const finish = (status: PermissionRequest['status']) => {
        if (!this.pending.delete(request.id)) return;
        signal.removeEventListener('abort', cancel);
        this.publish({ ...request, status });
        resolve(status === 'allowed');
      };
      this.pending.set(request.id, {
        finish,
        remember: () => {
          if (!this.rules || !request.suggestedPrefix || signal.aborted)
            throw new Error(
              'Reusable approval is unavailable for this request.',
            );
          this.rules.allow(request.directory, request.arguments?.command);
        },
      });
      signal.addEventListener('abort', cancel, { once: true });
      this.publish(request);
    });
  }

  answer(id: string, allow: unknown) {
    if (typeof allow !== 'boolean' && allow !== 'always')
      throw new Error('Invalid permission decision.');
    const pending = this.pending.get(id);
    if (!pending)
      throw new Error('This permission request is no longer active.');
    if (allow === 'always') pending.remember();
    pending.finish(allow ? 'allowed' : 'denied');
  }

  cancel() {
    [...this.pending.values()].forEach(({ finish }) => finish('cancelled'));
  }
}
