import { useEffect, useState } from 'react';
import type { AgentWorkspace as Workspace } from '../../../shared/agent-execution';
import './AgentWorkspace.css';

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
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    let active = true;
    window.electron?.ipcRenderer
      .invoke('get-agent-workspace', { sessionId })
      .then((value) => {
        if (active) setDirectory((value as Workspace)?.directory ?? '');
        return undefined;
      })
      .catch(() => {
        if (active) setError('Could not load the working folder.');
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
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
      if (value) setDirectory(value.directory);
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
        <span className="agent-workspace-hint">
          {running ? 'Coco is working' : 'Files & commands run here'}
        </span>
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
      {error && (
        <div className="agent-workspace-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
