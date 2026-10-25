import { useEffect, useState } from 'react';
import WorkspaceIcon from './WorkspaceIcon';
import { S } from './styles';

interface Props {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export default function WindowControls({ expanded, onExpandedChange }: Props) {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const remove = ipc?.on('chat-window-pin-state', (value: unknown) => {
      setPinned((value as { pinned?: boolean })?.pinned === true);
    });
    ipc?.sendMessage('get-chat-window-pin-state');
    return () => {
      remove?.();
    };
  }, []);
  return (
    <>
      <button
        type="button"
        style={{ ...S.iconBtn, ...(pinned ? S.iconBtnActive : {}) }}
        title={pinned ? 'Unpin window' : 'Pin window on top'}
        aria-label={pinned ? 'Unpin window' : 'Pin window on top'}
        aria-pressed={pinned}
        onClick={() =>
          window.electron?.ipcRenderer.sendMessage('set-chat-window-pinned', {
            pinned: !pinned,
          })
        }
      >
        <WorkspaceIcon name="pin" />
      </button>
      <button
        type="button"
        style={S.iconBtn}
        title={expanded ? 'Collapse' : 'Expand'}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onClick={() => onExpandedChange(!expanded)}
      >
        <WorkspaceIcon name={expanded ? 'collapse' : 'expand'} />
      </button>
      {window.electron?.platform !== 'darwin' && (
        <button
          type="button"
          style={S.iconBtn}
          title="Close"
          aria-label="Close"
          // A page-initiated window.close() destroys the window without a
          // 'close' event, discarding the chat. Main hides it instead.
          onClick={() =>
            window.electron?.ipcRenderer.sendMessage('close-chat-window')
          }
        >
          <WorkspaceIcon name="close" />
        </button>
      )}
    </>
  );
}
