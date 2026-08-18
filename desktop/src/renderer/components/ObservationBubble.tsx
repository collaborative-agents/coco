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
  /** Tutor mode active when the suggestion was generated. */
  scenario?: string;
}

const PREVIEW_CHARS = 120;

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const cutoff = text.lastIndexOf(' ', PREVIEW_CHARS);
  const end = cutoff > 40 ? cutoff : PREVIEW_CHARS;
  return `${text.slice(0, end)}…`;
}

function formatMetricTokens(n?: number): string {
  if (typeof n !== 'number') return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatMetricLatency(ms?: number): string {
  if (typeof ms !== 'number') return '0s';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function suggestionToolLabel(suggestion: InstantSuggestion): string {
  const preferred = (suggestion.availableTools ?? []).find(
    (tool) => tool.id === suggestion.targetTool,
  );
  if (preferred) return preferred.label;
  if (suggestion.availableTools?.[0]) return suggestion.availableTools[0].label;
  return 'an AI tool';
}

function preferredSuggestionTool(suggestion: InstantSuggestion) {
  return (
    (suggestion.availableTools ?? []).find(
      (tool) => tool.id === suggestion.targetTool,
    ) ?? suggestion.availableTools?.[0]
  );
}

function usesStageTaskRules(suggestion: InstantSuggestion): boolean {
  const prompt = suggestion.prompt ?? '';
  return ['Stage', 'Task', 'Rules'].every((label) =>
    new RegExp(`(^|\\n)\\s*${label}\\s*:`, 'i').test(prompt),
  );
}

export default function ObservationBubble({
  bubble,
  onHelpMe,
  onDismiss,
  onViewConversation,
  onChatAboutSuggestion,
  onMouseEnter,
  onMouseLeave,
}: {
  bubble: BubbleState | null;
  onHelpMe?: () => void;
  onDismiss?: () => void;
  onViewConversation?: () => void;
  onChatAboutSuggestion?: () => void;
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
  // One rating per revealed suggestion; locks the thumbs after the first click.
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  const [suggestionPage, setSuggestionPage] = useState<0 | 1>(0);
  // When the suggestion was revealed — lets latency_s capture time-to-rate.
  const suggestionShownAt = useRef<number>(Date.now());

  // Reset clicked state when a new observation arrives. ObservationBubble is
  // never remounted between observations (same position in the tree), so local
  // state would otherwise carry over from a previous bubble and leave the button
  // permanently stuck in the "Opening…" / disabled state.
  useEffect(() => {
    setHelpClicked(false);
    setToast(null);
    setRated(null);
  }, [bubble?.status, bubble?.phrase]);

  useEffect(() => {
    if (bubble?.suggestion) {
      suggestionShownAt.current = Date.now();
      setSuggestionPage(0);
    }
  }, [bubble?.suggestion]);

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
  const isFrameworkPager =
    suggestion != null && bubble.scenario === 'ai_upskilling';
  const isFrameworkOverview = isFrameworkPager && suggestionPage === 0;
  const suggestedTool = suggestion
    ? preferredSuggestionTool(suggestion)
    : undefined;
  const hasStageTaskRules = suggestion
    ? usesStageTaskRules(suggestion)
    : false;
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

  // Rate the revealed suggestion. Logged into feedback.jsonl via the sensing
  // server so it joins observations by observation_id.
  const rate = (dir: 'up' | 'down') => {
    if (rated || !suggestion) return;
    setRated(dir);
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      surface: 'bubble',
      observation_id: bubble?.observationId ?? null,
      status,
      latency_s: (Date.now() - suggestionShownAt.current) / 1000,
      text: suggestion.copyText ?? null,
    });
    window.electron?.ipcRenderer.sendMessage('activity-support-rated', {
      observationId: bubble?.observationId ?? null,
      rating: dir,
      ratedAt: Math.floor(Date.now() / 1000),
    });
    showToast('Thanks for the feedback');
  };

  return (
    <div
      className={`observation-bubble status-${status}${fadingOut ? ' is-leaving' : ''}${isTier3 ? ' is-tier3' : ''}${suggestion ? ' has-suggestion' : ''}${isFrameworkOverview ? ' is-framework-overview' : ''}`}
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
      {!isTier3 && !showHelpButton && !suggestion && (
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
        {isFrameworkOverview ? '4D framework' : suggestion ? suggestion.title : label}
      </div>

      {/* eslint-disable-next-line no-nested-ternary */}
      {isFrameworkOverview && suggestion ? (
        <div className="bubble-framework-overview">
          <div className="bubble-framework-heading">
            Turn this task into a clear AI handoff
          </div>
          <div className="bubble-framework-concept">
            <span className="bubble-framework-term">Delegation</span>
            <span>
              Choose what AI should handle. This task can be handed off to{' '}
              <strong>{suggestionToolLabel(suggestion)}</strong>.
            </span>
          </div>
          <div className="bubble-framework-concept">
            <span className="bubble-framework-term">Description</span>
            <span>
              {hasStageTaskRules ? (
                <>
                  This prompt uses <strong>Stage</strong> for context,{' '}
                  <strong>Task</strong> for the result you want, and{' '}
                  <strong>Rules</strong> for important requirements. The next
                  page shows all three parts.
                </>
              ) : (
                <>
                  Tell AI what you are working on, the result you want, and any
                  important requirements. The next page gives you a prompt you
                  can review and adapt.
                </>
              )}
            </span>
          </div>
        </div>
      ) : suggestion ? (
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

      {suggestion?.llm_metrics && !isFrameworkOverview && (
        <div className="bubble-metrics-row">
          <span>
            {formatMetricTokens(
              suggestion.llm_metrics.input_tokens ??
                suggestion.llm_metrics.prompt_tokens,
            )}{' '}
            in
          </span>
          <span>
            {formatMetricTokens(
              suggestion.llm_metrics.output_tokens ??
                suggestion.llm_metrics.completion_tokens,
            )}{' '}
            out
          </span>
          <span>{formatMetricLatency(suggestion.llm_metrics.duration_ms)}</span>
        </div>
      )}

      {/* Revealed instant suggestion. `content` → one Copy button. `delegate` →
          Copy prompt plus one Open button per the user's chatbots/agents so
          they pick where to hand the prompt. */}
      {suggestion && !isFrameworkOverview && suggestion.kind === 'content' && (
        <div className="bubble-tool-actions">
          <button
            type="button"
            className="bubble-action-btn"
            onClick={() => act(null)}
          >
            Copy
          </button>
          <button
            type="button"
            className="bubble-action-btn bubble-chat-action"
            onClick={onChatAboutSuggestion}
          >
            Chat about it
          </button>
        </div>
      )}
      {suggestion && !isFrameworkOverview && suggestion.kind === 'delegate' && (
        <div className="bubble-tool-actions">
          <button
            type="button"
            className="bubble-action-btn"
            onClick={() => act(null)}
          >
            Copy prompt
          </button>
          <button
            type="button"
            className="bubble-action-btn bubble-chat-action"
            onClick={onChatAboutSuggestion}
          >
            Chat about it
          </button>
          {suggestedTool && (
            <button
              type="button"
              className="bubble-action-btn bubble-tool-btn"
              onClick={() => act(suggestedTool.id, suggestedTool.label)}
            >
              Open {suggestedTool.label}
            </button>
          )}
        </div>
      )}

      {/* Rate the suggested prompt/content — one vote, then it locks. */}
      {suggestion && !isFrameworkOverview && (
        <div className="bubble-feedback-row">
          <button
            type="button"
            className={`bubble-feedback-btn${rated === 'up' ? ' is-rated' : ''}`}
            aria-label="Good suggestion"
            title="Good suggestion"
            disabled={rated !== null}
            onClick={() => rate('up')}
          >
            👍
          </button>
          <button
            type="button"
            className={`bubble-feedback-btn${rated === 'down' ? ' is-rated' : ''}`}
            aria-label="Not helpful"
            title="Not helpful"
            disabled={rated !== null}
            onClick={() => rate('down')}
          >
            👎
          </button>
        </div>
      )}

      {isFrameworkPager && (
        <div className="bubble-framework-pager" aria-label="Suggestion pages">
          <div className="bubble-framework-page-bars" aria-hidden="true">
            <span className={`bubble-framework-page-bar${suggestionPage === 0 ? ' is-active' : ''}`} />
            <span className={`bubble-framework-page-bar${suggestionPage === 1 ? ' is-active' : ''}`} />
          </div>
          <button
            type="button"
            className="bubble-framework-arrow"
            aria-label={suggestionPage === 0
              ? 'Show Description suggestion'
              : 'Back to Delegation and Description overview'}
            onClick={() => setSuggestionPage(suggestionPage === 0 ? 1 : 0)}
          >
            {suggestionPage === 0 ? '→' : '←'}
          </button>
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
