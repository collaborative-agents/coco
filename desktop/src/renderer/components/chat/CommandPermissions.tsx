import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  CommandApprovalRule,
  WorkspacePermissionRule,
} from '../../../shared/agent-execution';
import WorkspaceDialog from './WorkspaceDialog';
import './WorkspaceDialog.css';
import './CommandPermissions.css';

export default function CommandPermissions({
  sessionId,
  onClose,
  workspaceAccess,
}: {
  sessionId: string | null;
  onClose: () => void;
  workspaceAccess?: {
    granted: boolean;
    canRevoke: boolean;
    running: boolean;
    onRevoke: () => Promise<void>;
  };
}) {
  const [rules, setRules] = useState<CommandApprovalRule[]>([]);
  const [fileRules, setFileRules] = useState<WorkspacePermissionRule[]>([]);
  const [directory, setDirectory] = useState('');
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await window.electron.ipcRenderer.invoke(
          'list-command-approvals',
          sessionId,
        );
        if (active) {
          setRules(value.rules);
          setFileRules(value.fileRules ?? []);
          setDirectory(value.directory);
        }
      } catch {
        if (active) setError('Could not load command permissions.');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [sessionId]);
  const revoke = async (id: string, file = false) => {
    setRemoving(id);
    setError('');
    try {
      const value = await window.electron.ipcRenderer.invoke(
        file ? 'revoke-file-approval' : 'revoke-command-approval',
        sessionId,
        id,
      );
      setRules(value.rules);
      setFileRules(value.fileRules ?? []);
    } catch {
      setError('Could not remove this permission. Try again.');
    } finally {
      setRemoving('');
    }
  };
  return createPortal(
    <WorkspaceDialog
      open
      title="Workspace access"
      onClose={onClose}
      className="workspace-access-dialog"
    >
      <div className="command-permissions">
        <p className="command-permissions-directory">{directory}</p>
        {workspaceAccess && (
          <section
            className="workspace-access-section"
            aria-label="Folder access"
          >
            <div className="workspace-access-heading">
              <h3>Read and edit files</h3>
              <span>{workspaceAccess.granted ? 'Allowed' : 'Ask first'}</span>
            </div>
            <p>
              {workspaceAccess.granted
                ? 'Coco can read and edit files here across chats and restarts until revoked.'
                : 'Coco will ask before accessing this folder.'}
            </p>
            {workspaceAccess.granted && (
              <button
                type="button"
                disabled={!workspaceAccess.canRevoke || revoking}
                onClick={async () => {
                  setRevoking(true);
                  setError('');
                  try {
                    await workspaceAccess.onRevoke();
                  } catch {
                    setError('Could not revoke folder access. Try again.');
                  } finally {
                    setRevoking(false);
                  }
                }}
              >
                {revoking ? 'Revoking…' : 'Revoke folder access'}
              </button>
            )}
            {workspaceAccess.granted && workspaceAccess.running && (
              <p className="command-permissions-note">
                Stop the current run to revoke folder access.
              </p>
            )}
          </section>
        )}
        <section
          className="workspace-access-section"
          aria-label="Command approvals"
        >
          <h3>Saved command approvals</h3>
          <p>Commands Coco can run without asking in this workspace.</p>
          {loading ? (
            <p role="status">Loading permissions…</p>
          ) : (
            <>
              {!rules.length && !error && <p>No saved command approvals.</p>}
              {rules.map((rule) => (
                <div className="command-permissions-rule" key={rule.id}>
                  <code>{rule.prefix.join(' ')} …</code>
                  <button
                    type="button"
                    disabled={Boolean(removing)}
                    onClick={() => revoke(rule.id)}
                    aria-label={`Remove ${rule.prefix.join(' ')} approval`}
                  >
                    {removing === rule.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ))}
              {rules.length > 0 && (
                <p className="command-permissions-note">
                  Removing a rule restores approval prompts for future commands.
                  It won’t stop a command already running.
                </p>
              )}
            </>
          )}
        </section>
        <section
          className="workspace-access-section"
          aria-label="Additional file access"
        >
          <h3>Additional file access</h3>
          <p>
            Saved access outside this workspace, reused across chats and
            restarts.
          </p>
          {!loading && !fileRules.length && <p>No saved file permissions.</p>}
          {fileRules.map((rule) => (
            <div className="command-permissions-rule" key={rule.id}>
              <span>
                {rule.fileAccess?.mode === 'write' ? 'Read and edit' : 'Read'}:{' '}
                <code>{rule.fileAccess?.path}</code>
                {rule.fileAccess?.scope === 'directory'
                  ? ' (including contents)'
                  : ''}
              </span>
              <button
                type="button"
                disabled={Boolean(removing)}
                onClick={() => revoke(rule.id, true)}
                aria-label={`Remove access to ${rule.fileAccess?.path}`}
              >
                Remove
              </button>
            </div>
          ))}
          {fileRules.length > 0 && (
            <p>
              Removing a grant restores prompts for future tool calls. It does
              not stop an operation already running.
            </p>
          )}
        </section>
        {error && <p role="alert">{error}</p>}
      </div>
    </WorkspaceDialog>,
    document.body,
  );
}
