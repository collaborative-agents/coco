import WorkspaceIcon from './WorkspaceIcon';
import { S } from './styles';

interface Props {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export default function WindowControls({ expanded, onExpandedChange }: Props) {
  return (
    <>
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
