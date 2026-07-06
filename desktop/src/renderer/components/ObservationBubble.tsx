import { useEffect, useRef, useState } from 'react';
import {
  InstantSuggestion,
  ObservationStatus,
  STATUS_LABEL,
} from './observation-types';

export interface BubbleState {
  status: ObservationStatus;
  phrase: string;
  fadingOut: boolean;
  /** Tier 2: show "Help me with this" button immediately. */
  showHelpButton?: boolean;
  /**
   * Raw observation text from the sensing server (cleaned of JSON wrappers /
   * bracketed metadata). Sent to the webapp as context when the user taps
   * "Help me with this", so the tutor and the chat history both show what
   * triggered the request.
   */
  rawObservation?: string;
  /** Stable id of the observer call behind this bubble (for feedback joins). */
  observationId?: string;
  /**
   * Tier 3: raw tutor guidance text. When set, the bubble renders a truncated
   * preview of the message instead of the observer phrase, plus a
   * "View conversation" button.
   */
  tutorMessage?: string;
  /**
   * Instant suggestion revealed in-place after the user clicks "Help me with
   * this" (pre-computed while the bubble was on screen). When set, the bubble
   * shows the ready-to-use content with a Copy button, or a delegation prompt
   * with an Approve button, instead of the "Help me with this" button.
   */
  suggestion?: InstantSuggestion;
}

const PREVIEW_CHARS = 120;

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const cutoff = text.lastIndexOf(' ', PREVIEW_CHARS);
  const end = cutoff > 40 ? cutoff : PREVIEW_CHARS;
  return `${text.slice(0, end)}…`;
}

export default function ObservationBubble({
  bubble,
  onHelpMe,
  onDismiss,
  onViewConversation,
  onMouseEnter,
  onMouseLeave,
}: {
  bubble: BubbleState | null;
  onHelpMe?: () => void;
  onDismiss?: () => void;
  onViewConversation?: () => void;
  /** Hovering pauses the auto-hide so the user can read / copy the bubble. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  // Local clicked state: shows "Opening…" immediately after the user taps the
  // button so there is visible confirmation while the suggestion is fetched.
  const [helpClicked, setHelpClicked] = useState(false);
  // Transient confirmation shown after Copy / Approve.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset clicked state when a new observation arrives. ObservationBubble is
  // never remounted between observations (same position in the tree), so local
  // state would otherwise carry over from a previous bubble and leave the button
  // permanently stuck in the "Opening…" / disabled state.
  useEffect(() => {
    setHelpClicked(false);
    setToast(null);
  }, [bubble?.status, bubble?.phrase]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  if (!bubble) return null;
  const { status, phrase, fadingOut, showHelpButton, tutorMessage, suggestion } =
    bubble;
  const isTier3 = !!tutorMessage;
  const label = isTier3 ? 'AI Tutor' : (STATUS_LABEL[status] ?? STATUS_LABEL.observing);

  // Copy the prompt/content and, when a tool is chosen, launch it. `toolId` null
  // means copy-only.
  const act = (toolId: string | null, toolLabel?: string) => {
    if (!suggestion) return;
    window.electron?.ipcRenderer.sendMessage('suggestion-action', {
      toolId: toolId ?? null,
      copyText: suggestion.copyText ?? '',
    });
    showToast(
      toolId ? `Opening ${toolLabel} — paste with ⌘V` : 'Copied to clipboard',
    );
  };

  return (
    <div
      className={`observation-bubble status-${status}${fadingOut ? ' is-leaving' : ''}${isTier3 ? ' is-tier3' : ''}${suggestion ? ' has-suggestion' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Dismiss (×) on Tier-2 bubbles and on any revealed suggestion (which is
          pinned open and can only be closed here). */}
      {!isTier3 && (showHelpButton || suggestion) && onDismiss && (
        <button
          type="button"
          className="bubble-dismiss-btn"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      )}

      {/* Tier-1 (progress/observing): no suggestion. A passive "?" explains that
          there's nothing proactive right now and points to clicking the pet. */}
      {!isTier3 && !showHelpButton && (
        <span
          className="bubble-help-badge"
          tabIndex={0}
          role="img"
          aria-label="Why no suggestion?"
        >
          ?
          <span className="bubble-help-tip" role="tooltip">
            No proactive suggestion right now. If you still need help, click me
            (the fox) to open the chat.
          </span>
        </span>
      )}

      <div className="observation-bubble-label">
        {suggestion ? suggestion.title : label}
      </div>

      {/* eslint-disable-next-line no-nested-ternary */}
      {suggestion ? (
        <div className="observation-bubble-text observation-suggestion-body">
          {suggestion.kind === 'delegate'
            ? suggestion.prompt
            : suggestion.body}
        </div>
      ) : isTier3 ? (
        <div className="observation-bubble-text observation-bubble-tutor-preview">
          {truncatePreview(tutorMessage)}
        </div>
      ) : (
        <div className="observation-bubble-text">{phrase}</div>
      )}

      {/* Revealed instant suggestion. `content` → one Copy button. `delegate` →
          Copy prompt plus one Open button per the user's chatbots/agents so
          they pick where to hand the prompt. */}
      {suggestion && suggestion.kind === 'content' && (
        <button type="button" className="bubble-action-btn" onClick={() => act(null)}>
          Copy
        </button>
      )}
      {suggestion && suggestion.kind === 'delegate' && (
        <div className="bubble-tool-actions">
          <button type="button" className="bubble-action-btn" onClick={() => act(null)}>
            Copy prompt
          </button>
          {(suggestion.availableTools ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              className="bubble-action-btn bubble-tool-btn"
              onClick={() => act(t.id, t.label)}
            >
              Open {t.label}
            </button>
          ))}
        </div>
      )}

      {isTier3 && (
        <button
          type="button"
          className="bubble-action-btn"
          onClick={onViewConversation}
        >
          View conversation →
        </button>
      )}

      {!isTier3 && !suggestion && showHelpButton && (
        <button
          type="button"
          className={`bubble-action-btn${helpClicked ? ' is-clicked' : ''}`}
          disabled={helpClicked}
          onClick={() => {
            setHelpClicked(true);
            onHelpMe?.();
          }}
        >
          {helpClicked ? 'Opening…' : 'Help me with this'}
        </button>
      )}

      {toast && <div className="observation-bubble-toast">{toast}</div>}

      <span className="observation-bubble-tail" aria-hidden />
    </div>
  );
}
