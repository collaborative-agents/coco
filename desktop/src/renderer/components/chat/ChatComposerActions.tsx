import type { ReactNode } from 'react';
import { S } from './styles';
import ContextViewer from './ContextViewer';
import ActionTooltip from './ActionTooltip';

interface Props {
  onAttachFiles: () => Promise<void>;
  attachmentDisabled: boolean;
  modelPicker?: ReactNode;
  sessionId: string | null;
  voiceActive: boolean;
  voiceDisabled: boolean;
  onVoiceClick: () => Promise<void>;
  canSend: boolean;
  onSend: () => void;
}

export default function ChatComposerActions({
  onAttachFiles,
  attachmentDisabled,
  modelPicker,
  sessionId,
  voiceActive,
  voiceDisabled,
  onVoiceClick,
  canSend,
  onSend,
}: Props) {
  return (
    <div className="chat-composer-actions">
      <div className="chat-composer-tools">
        <ActionTooltip label="Attach files">
          <button
            type="button"
            style={{
              ...S.micBtn,
              ...(attachmentDisabled ? S.sendBtnDisabled : {}),
            }}
            disabled={attachmentDisabled}
            onClick={onAttachFiles}
            aria-label="Attach files"
          >
            <svg
              aria-hidden="true"
              focusable="false"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" />
            </svg>
          </button>
        </ActionTooltip>

        <ContextViewer key={sessionId} sessionId={sessionId} />
      </div>
      <div className="chat-composer-send-actions">
        {modelPicker}
        <ActionTooltip
          label={
            voiceActive
              ? 'Stop and send voice message'
              : 'Record a voice message'
          }
        >
          <button
            type="button"
            aria-label={
              voiceActive ? 'Stop voice recording' : 'Start voice recording'
            }
            aria-pressed={voiceActive}
            style={{
              ...S.micBtn,
              ...(voiceActive ? S.micBtnActive : {}),
              ...(voiceDisabled ? S.sendBtnDisabled : {}),
            }}
            disabled={voiceDisabled}
            onClick={onVoiceClick}
          >
            {voiceActive ? (
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <rect x="4" y="4" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5M12 18.5V22M9 22h6" />
              </svg>
            )}
          </button>
        </ActionTooltip>
        <ActionTooltip label="Send message">
          <button
            type="button"
            aria-label="Send"
            style={{ ...S.sendBtn, ...(canSend ? {} : S.sendBtnDisabled) }}
            onClick={onSend}
            disabled={!canSend}
          >
            <svg
              aria-hidden="true"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </ActionTooltip>
      </div>
    </div>
  );
}
