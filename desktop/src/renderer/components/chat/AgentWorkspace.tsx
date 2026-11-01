import { useEffect, useState } from 'react';
import type { AgentWorkspace as Workspace } from '../../../shared/agent-execution';
import './AgentWorkspace.css';
import CommandPermissions from './CommandPermissions';

export default function AgentWorkspace({
  sessionId,
  disabled,
  running,
  onStop,
}: {
  sessionId: string | null;
  disabled: boolean;
  running: boolean;
  onStop: () => Promise<void>;
}) {
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [accessGranted, setAccessGranted] = useState(false);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    let active = true;
    window.electron?.ipcRenderer
      .invoke('get-agent-workspace', { sessionId })
      .then((value) => {
        if (active) {
          setDirectory((value as Workspace)?.directory ?? '');
          setAccessGranted((value as Workspace)?.accessGranted === true);
        }
        return undefined;
      })
      .catch(() => {
        if (active) setError('Could not load the working folder.');
      });
    return () => {
      active = false;
    };
  }, [sessionId, running]);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  const choose = async () => {
    setChoosing(true);
    setError('');
    try {
      const value = (await window.electron?.ipcRenderer.invoke(
        'choose-agent-workspace',
        { sessionId },
      )) as Workspace | null;
      if (value) {
        setDirectory(value.directory);
        setAccessGranted(value.accessGranted);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not choose a folder.',
      );
    } finally {
      setChoosing(false);
    }
  };
  return (
    <div className="agent-workspace">
      <div className="agent-workspace-row">
        <button
          type="button"
          className="agent-folder"
          disabled={disabled || choosing || !sessionId}
          onClick={choose}
          title={directory || 'Choose a working folder'}
          aria-label="Choose working folder"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
          <span>
            {choosing
              ? 'Choosing…'
              : directory.split(/[\\/]/).filter(Boolean).pop() ||
                'Working folder'}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        <button
          type="button"
          className="agent-access"
          aria-label="Workspace access"
          aria-haspopup="dialog"
          title={
            accessGranted
              ? 'Workspace access granted'
              : 'Workspace access requires approval'
          }
          onClick={() => setPermissionsOpen(true)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
            {accessGranted && <path d="m8 12 3 3 5-6" />}
          </svg>
          Access <span aria-hidden="true">⌄</span>
        </button>
        {running && (
          <button
            type="button"
            className="agent-stop"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop();
              } catch {
                setError('Could not stop the run. Please try again.');
                setStopping(false);
              }
            }}
          >
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}
      </div>
      {permissionsOpen && (
        <CommandPermissions
          key={sessionId}
          sessionId={sessionId}
          workspaceAccess={{
            granted: accessGranted,
            canRevoke: Boolean(sessionId) && !running && !disabled && !choosing,
            running,
            onRevoke: async () => {
              await window.electron.ipcRenderer.invoke(
                'revoke-agent-workspace',
                sessionId,
              );
              setAccessGranted(false);
            },
          }}
          onClose={() => setPermissionsOpen(false)}
        />
      )}
      {error && (
        <div className="agent-workspace-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
