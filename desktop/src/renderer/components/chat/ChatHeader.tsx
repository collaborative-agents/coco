import { S } from './styles';
import HeaderActionIcon from './WorkspaceIcon';
import WindowControls from './WindowControls';

interface Props {
  chatEnabled: boolean;
  sending: boolean;
  startingNewSession: boolean;
  handleNewSession: () => Promise<void>;
  expanded: boolean;
  changeExpanded: (value: boolean) => void;
}

export default function ChatHeader({
  chatEnabled,
  startingNewSession,
  handleNewSession,
  expanded,
  changeExpanded,
}: Props) {
  return (
    <div
      className="workspace-chat-actions"
      role="toolbar"
      aria-label="Chat actions"
      style={S.header}
    >
      <div style={S.headerBtns}>
        <button
          type="button"
          style={{
            ...S.newSessionBtn,
            ...(startingNewSession || !chatEnabled ? S.sendBtnDisabled : {}),
          }}
          title="Start a new session"
          aria-label="Start a new session"
          disabled={startingNewSession || !chatEnabled}
          onClick={handleNewSession}
        >
          <HeaderActionIcon name="new" />
          <span>{startingNewSession ? 'Starting…' : 'New'}</span>
        </button>
        <WindowControls expanded={expanded} onExpandedChange={changeExpanded} />
      </div>
    </div>
  );
}
