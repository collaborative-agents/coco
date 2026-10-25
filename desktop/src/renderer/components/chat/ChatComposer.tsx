import type React from 'react';
import { S } from './styles';
import ChatComposerActions from './ChatComposerActions';
import './ChatComposer.css';
import AgentWorkspace from './AgentWorkspace';
import type { SavedConversation } from './types';
import type { VoiceRecorderStatus } from '../../voice-recorder';

const HOTKEY_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    ? 'Cmd + Shift + Space'
    : 'Ctrl + Shift + Space';

interface Props {
  workspaceSessionId: string | null;
  agentRunning: boolean;
  stopAgent: () => Promise<void>;
  pendingContextLabel: string | null;
  pendingContextRef: React.RefObject<string | null>;
  setPendingContextLabel: React.Dispatch<React.SetStateAction<string | null>>;
  pendingImages: string[];
  openImagePreview: (imageDataUrl: string) => void;
  openImageAnnotator: (imageDataUrl: string) => void;
  pendingHotkeyImagesRef: React.RefObject<Set<string>>;
  setPendingImages: React.Dispatch<React.SetStateAction<string[]>>;
  understandingError: string;
  sending: boolean;
  voiceState: VoiceRecorderStatus | 'idle' | 'requesting';
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  voiceActive: boolean;
  startingNewSession: boolean;
  reviewing: SavedConversation | null;
  handleVoiceClick: (fromWakeWord?: boolean) => Promise<void>;
  profile: { scenario: string; aiTools: string[]; hideAvatar: boolean };
  checkingUnderstanding: boolean;
  canSend: boolean;
  handleSend: () => void;
  voiceStatusText: string;
  voiceError: string;
}

export default function ChatComposer({
  workspaceSessionId,
  agentRunning,
  stopAgent,
  pendingContextLabel,
  pendingContextRef,
  setPendingContextLabel,
  pendingImages,
  openImagePreview,
  openImageAnnotator,
  pendingHotkeyImagesRef,
  setPendingImages,
  understandingError,
  sending,
  voiceState,
  input,
  setInput,
  onPaste,
  onKeyDown,
  voiceActive,
  startingNewSession,
  reviewing,
  handleVoiceClick,
  profile,
  checkingUnderstanding,
  canSend,
  handleSend,
  voiceStatusText,
  voiceError,
}: Props) {
  return (
    <div style={S.composer}>
      <AgentWorkspace
        key={workspaceSessionId}
        sessionId={workspaceSessionId}
        disabled={sending || startingNewSession || checkingUnderstanding}
        running={agentRunning}
        onStop={stopAgent}
      />
      <div className="chat-composer-surface" style={S.composerSurface}>
        {pendingContextLabel && (
          <div style={S.pendingContext}>
            <span style={S.pendingContextText}>
              Suggestion context attached: {pendingContextLabel}
            </span>
            <button
              type="button"
              style={S.pendingContextX}
              aria-label="Remove suggestion context"
              title="Remove suggestion context"
              onClick={() => {
                pendingContextRef.current = null;
                setPendingContextLabel(null);
              }}
            >
              ×
            </button>
          </div>
        )}
        {pendingImages.length > 0 && (
          <div style={S.pending}>
            {pendingImages.map((src, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} style={S.pendingThumbWrap}>
                <button
                  type="button"
                  style={S.imagePreviewButton}
                  aria-label={`Preview attached image ${i + 1}`}
                  title="Preview image"
                  onClick={() => openImagePreview(src)}
                >
                  <img src={src} alt={`Attachment ${i + 1}`} style={S.thumb} />
                </button>
                {pendingHotkeyImagesRef.current.has(src) && (
                  <button type="button" style={S.pendingAnnotate}
                    aria-label={`Annotate hotkey screenshot ${i + 1}`}
                    title="Annotate screenshot" onClick={() => openImageAnnotator(src)}>
                    ✎ Edit
                  </button>
                )}
                <button
                  type="button"
                  style={S.pendingX}
                  aria-label={`Remove attached image ${i + 1}`}
                  title="Remove image"
                  onClick={() => {
                    pendingHotkeyImagesRef.current.delete(src);
                    setPendingImages((prev) => prev.filter((_, j) => j !== i));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {understandingError && (
          <div style={S.understandingError}>{understandingError}</div>
        )}
        <textarea
          style={S.textarea}
          rows={2}
          aria-label="Message Coco"
          placeholder={
            voiceState === 'idle'
              ? 'Ask Coco… (paste an image to attach)'
              : 'Listening to your voice…'
          }
          value={input}
          disabled={voiceState !== 'idle'}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        <ChatComposerActions
          sessionId={workspaceSessionId}
          voiceActive={voiceActive}
          voiceDisabled={
            sending ||
            startingNewSession ||
            checkingUnderstanding ||
            Boolean(reviewing) ||
            voiceState === 'requesting'
          }
          onVoiceClick={() => handleVoiceClick()}
          canSend={canSend}
          onSend={handleSend}
        />
      </div>
      {voiceState !== 'idle' && (
        <div style={S.voiceHint}>{voiceStatusText}</div>
      )}
      {voiceState === 'idle' && voiceError && (
        <div style={S.voiceError}>{voiceError}</div>
      )}
      {voiceState === 'idle' && !voiceError && (
        <div style={S.hotkeyHint}>
          Press <span style={S.hotkeyKbd}>{HOTKEY_LABEL}</span> anytime to grab
          a screenshot
        </div>
      )}
    </div>
  );
}
