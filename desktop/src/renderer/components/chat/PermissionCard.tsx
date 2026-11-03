import { useState } from 'react';
import type { PermissionRequest } from '../../../shared/agent-execution';
import './PermissionCard.css';

export default function PermissionCard({
  request,
  requestId,
  interactive,
}: {
  request: PermissionRequest;
  requestId?: string;
  interactive: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const workspace = request.kind === 'workspace';
  const shell = request.tool === 'bash';
  const pending =
    request.status === 'pending' &&
    interactive &&
    Boolean(requestId) &&
    decision === null;
  let status =
    request.status === 'pending' ? 'Approval unavailable' : request.status;
  if (pending) status = 'Waiting for approval';
  else if (decision !== null && request.status === 'pending')
    status = decision ? 'allowed' : 'denied';
  const title = workspace
    ? 'Allow folder access?'
    : `Allow ${shell ? 'this command' : request.tool}?`;

  let scopeHint = 'Approval applies to this action only.';
  if (request.suggestedPrefix)
    scopeHint =
      'Allow once, or save the displayed command rule for this workspace.';
  if (workspace)
    scopeHint =
      'Coco can read, create, and edit files in this folder for this conversation until you revoke access or quit Coco.';

  const answer = async (allow: boolean | 'always') => {
    if (!pending || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      if (!window.electron) throw new Error('Chat connection is unavailable.');
      await window.electron.ipcRenderer.invoke(
        'answer-agent-permission',
        requestId,
        request.id,
        allow,
      );
      setDecision(allow !== false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not submit approval.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'allowed' || status === 'cancelled') return null;
  if (status === 'denied') {
    let subject = `Use ${request.tool}`;
    if (workspace) subject = 'Read and edit folder';
    else if (shell) subject = 'Run command';
    return (
      <div className="agent-permission-log">
        <div className="agent-permission-heading">
          <strong>{subject}</strong>
        </div>
        <div className="agent-permission-directory">{request.directory}</div>
        {!workspace && (
          <pre className="agent-permission-request">
            {shell
              ? String(request.arguments?.command ?? '')
              : JSON.stringify(request.arguments, null, 2)}
          </pre>
        )}
        <div className={`agent-permission-outcome ${status}`} role="status">
          Denied by the user
        </div>
      </div>
    );
  }

  return (
    <section className="agent-permission-card" aria-label="Permission request">
      <div className="agent-permission-heading">
        <strong>{title}</strong>
        <span role="status">{status}</span>
      </div>
      <div className="agent-permission-directory">{request.directory}</div>
      {!workspace && (
        <pre className="agent-permission-command">
          {shell
            ? String(request.arguments?.command ?? '')
            : JSON.stringify(request.arguments, null, 2)}
        </pre>
      )}
      <p>{scopeHint}</p>
      {!workspace && (
        <p className="agent-permission-note">
          {shell
            ? 'This command can access files outside this folder, use the network, and change external services.'
            : 'This tool may send data or change an external service.'}
        </p>
      )}
      {pending && (
        <div className="agent-permission-actions">
          <button
            type="button"
            disabled={submitting}
            onClick={() => answer(false)}
          >
            Deny
          </button>
          {shell && request.suggestedPrefix && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => answer('always')}
            >
              Always allow <code>{request.suggestedPrefix.join(' ')} …</code> in
              this workspace
            </button>
          )}
          <button
            type="button"
            className="agent-permission-allow"
            disabled={submitting}
            onClick={() => answer(true)}
          >
            {workspace ? 'Allow folder access' : 'Allow once'}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

PermissionCard.defaultProps = { requestId: undefined };
