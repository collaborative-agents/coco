import type React from 'react';
import { S } from './styles';
import type { SavedConversation } from './types';
import HeaderActionIcon from './WorkspaceIcon';
import WindowControls from './WindowControls';

interface Props {
  showHealth?: boolean;
  chatHealthLabel: string;
  chatHealthColor: string;
  chatEnabled: boolean;
  chatHealthTitle: string;
  hasChatHealthIssue: boolean;
  setShowHistory: React.Dispatch<React.SetStateAction<boolean>>;
  setReviewing: React.Dispatch<React.SetStateAction<SavedConversation | null>>;
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
  sending: boolean;
  startingNewSession: boolean;
  handleNewSession: () => Promise<void>;
  expanded: boolean;
  changeExpanded: (value: boolean) => void;
}

export default function ChatHeader({
  showHealth = true,
  chatHealthLabel,
  chatHealthColor,
  chatEnabled,
  chatHealthTitle,
  hasChatHealthIssue,
  setShowHistory,
  setReviewing,
  setShowSettings,
  sending,
  startingNewSession,
  handleNewSession,
  expanded,
  changeExpanded,
}: Props) {
  return (
    <div role="banner" style={S.header}>
      <span style={S.brand}>
        {showHealth && (
          <span
            role="status"
            aria-label={chatHealthLabel}
            style={{ ...S.statusDot, background: chatHealthColor }}
            title={chatHealthTitle}
          />
        )}
        Coco
        {showHealth &&
          (hasChatHealthIssue ? (
            <button
              type="button"
              style={{ ...S.healthHeaderButton, color: chatHealthColor }}
              title={chatHealthTitle}
              aria-label={`${chatHealthLabel}. Open Settings`}
              onClick={() => {
                setShowHistory(false);
                setReviewing(null);
                setShowSettings(true);
              }}
            >
              · {chatHealthLabel}
            </button>
          ) : (
            <span style={S.sub} title={chatHealthTitle}>
              · {chatHealthLabel}
            </span>
          ))}
      </span>
      <div style={S.headerBtns}>
        <button
          type="button"
          style={{
            ...S.newSessionBtn,
            ...(sending || startingNewSession || !chatEnabled
              ? S.sendBtnDisabled
              : {}),
          }}
          title="Start a new session"
          aria-label="Start a new session"
          disabled={sending || startingNewSession || !chatEnabled}
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
