import { useCallback, useEffect, useRef, useState } from 'react';
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
  const cardRef = useRef<HTMLElement>(null);
  const answeringRef = useRef(false);
  const workspace = request.kind === 'workspace';
  const file = request.kind === 'path';
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
    : file
      ? `Allow ${request.fileAccess?.mode === 'write' ? 'read and edit' : 'read'} access?`
      : `Allow ${shell ? 'this command' : request.tool}?`;

  let scopeHint = 'Approval applies to this action only.';
  if (request.suggestedPrefix)
    scopeHint =
      'Allow once, or save the displayed command rule for this workspace.';
  if (workspace)
    scopeHint =
      'Coco can read, create, and edit files in this folder. This grant is remembered across chats and restarts until you revoke it.';

  if (file)
    scopeHint = `Access applies to this ${request.fileAccess?.scope === 'directory' ? 'folder and its contents' : 'file'}. Allow once, or remember it for this workspace across chats and restarts.`;

  const answer = useCallback(
    async (allow: boolean | 'always') => {
      if (!pending || answeringRef.current) return;
      answeringRef.current = true;
      setSubmitting(true);
      setError('');
      try {
        if (!window.electron)
          throw new Error('Chat connection is unavailable.');
        await window.electron.ipcRenderer.invoke(
          'answer-agent-permission',
          requestId,
          request.id,
          allow,
        );
        setDecision(allow !== false);
      } catch (err) {
        answeringRef.current = false;
        setError(
          err instanceof Error ? err.message : 'Could not submit approval.',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [pending, requestId, request.id],
  );

  useEffect(() => {
    if (!pending) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (event.key !== 'Enter' && event.key !== 'Escape')
      )
        return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        // Keep draft editing and native keyboard activation of controls intact.
        if (
          target.closest(
            'input, select, [contenteditable="true"], [role="dialog"]',
          )
        )
          return;
        if (target instanceof HTMLTextAreaElement && target.value.length > 0)
          return;
        if (event.key === 'Enter' && target.closest('button, a')) return;
      }
      // One keypress answers only one prompt, even with concurrent requests.
      const focusedCard =
        target instanceof HTMLElement
          ? target.closest('[data-pending-permission]')
          : null;
      const activeCard =
        focusedCard ?? document.querySelector('[data-pending-permission]');
      if (activeCard !== cardRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      void answer(event.key === 'Enter');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pending, answer]);

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
    <section
      ref={cardRef}
      className="agent-permission-card"
      aria-label="Permission request"
      data-pending-permission={pending ? '' : undefined}
    >
      <div className="agent-permission-heading">
        <strong>{title}</strong>
        <span role="status">{status}</span>
      </div>
      <div className="agent-permission-directory">{request.directory}</div>
      {!workspace && !file && (
        <pre className="agent-permission-command">
          {shell
            ? String(request.arguments?.command ?? '')
            : JSON.stringify(request.arguments, null, 2)}
        </pre>
      )}
      {file && (
        <div className="agent-permission-directory">
          {request.fileAccess?.path}
        </div>
      )}
      <p>{scopeHint}</p>
      {!workspace && !file && (
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
            aria-keyshortcuts="Escape"
            title="Deny (Esc)"
            onClick={() => answer(false)}
          >
            Deny
          </button>
          {file && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => answer('always')}
            >
              Always allow in this workspace
            </button>
          )}
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
            aria-keyshortcuts="Enter"
            title={`${workspace ? 'Allow folder access' : 'Allow once'} (Enter)`}
            disabled={submitting}
            onClick={() => answer(true)}
          >
            {workspace ? 'Allow folder access' : 'Allow once'}
          </button>
        </div>
      )}
      {pending && (
        <p className="agent-permission-note">
          Enter to {workspace ? 'allow folder access' : 'allow once'} · Esc to
          deny
          {' · '}Tab to choose an option. Shortcuts pause while typing a
          message.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

PermissionCard.defaultProps = { requestId: undefined };
