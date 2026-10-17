import { S } from './styles';

interface Props {
  voiceButtonLabel?: string;
  showUnderstandingCheck: boolean;
  checkingUnderstanding: boolean;
  understandingDisabled: boolean;
  hasDraft: boolean;
  onCheckUnderstanding: () => Promise<void>;
  voiceActive: boolean;
  voiceDisabled: boolean;
  onVoiceClick: () => Promise<void>;
  canSend: boolean;
  onSend: () => void;
}

export default function ChatComposerActions({
  voiceButtonLabel,
  showUnderstandingCheck,
  checkingUnderstanding,
  understandingDisabled,
  hasDraft,
  onCheckUnderstanding,
  voiceActive,
  voiceDisabled,
  onVoiceClick,
  canSend,
  onSend,
}: Props) {
  return (
    <div style={S.composerActions}>
      {showUnderstandingCheck && (
        <button
          type="button"
          style={{
            ...S.finishTaskBtn,
            ...(understandingDisabled ? S.sendBtnDisabled : {}),
          }}
          disabled={understandingDisabled}
          onClick={onCheckUnderstanding}
          title={
            hasDraft
              ? 'Send or clear your message before checking your understanding'
              : 'Review what you learned with Coco and take a short quiz. Completing or skipping the recap ends this session.'
          }
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M9 18h6M10 21h4M9 15v-1a6 6 0 1 1 6 0v1H9Z" />
          </svg>
          {checkingUnderstanding ? 'Opening…' : 'Check my understanding'}
        </button>
      )}
      <div style={S.composerSendActions}>
        <button
          type="button"
          aria-label={
            voiceButtonLabel ||
            (voiceActive ? 'Stop voice recording' : 'Start voice recording')
          }
          aria-pressed={voiceActive}
          title={voiceActive ? 'Stop and send voice message' : 'Talk to Coco'}
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
        <button
          type="button"
          aria-label="Send"
          title="Send message"
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
      </div>
    </div>
  );
}
