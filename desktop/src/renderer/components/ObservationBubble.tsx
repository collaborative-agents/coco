import { useEffect, useRef, useState } from 'react';
import {
  InstantSuggestion,
  ObservationStatus,
  STATUS_LABEL,
} from './observation-types';
import {
  buildFrameworkOverview,
  buildSuggestionExplanation,
} from './framework-overview';
import RatingButtons from './RatingButtons';

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
  agentReply?: { sessionId: string; requestId: string };
  agentWorking?: { sessionId: string; requestId: string };
  /**
   * Instant suggestion revealed in-place after the user clicks "Help me with
   * this" (pre-computed while the bubble was on screen). When set, the bubble
   * shows the content or delegation prompt with one Chat/Run with Coco action
   * instead of the "Help me with this" button.
   */
  suggestion?: InstantSuggestion;
  /** Tutor mode active when the suggestion was generated. */
  scenario?: string;
  /**
   * Set when the bubble is a session invite. The phrase is the previewed
   * suggestion's title, or the detected task when there is no preview.
   */
  invite?: { inviteId: string; hasPreview: boolean };
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

export default function ObservationBubble({
  bubble,
  onHelpMe,
  onDismiss,
  onViewConversation,
  onChatAboutSuggestion,
  onRunSuggestion,
  onMouseEnter,
  onMouseLeave,
}: {
  bubble: BubbleState | null;
  onHelpMe?: () => void;
  onDismiss?: () => void;
  onViewConversation?: () => void;
  onChatAboutSuggestion?: () => void;
  onRunSuggestion?: () => void;
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
  // Current rating for the revealed suggestion. The opposite thumb remains
  // available so an accidental rating can be corrected.
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
  const {
    status,
    phrase,
    fadingOut,
    showHelpButton,
    tutorMessage,
    suggestion,
  } = bubble;
  const isTier3 = !!tutorMessage;
  const isFrameworkPager =
    suggestion != null && bubble.scenario === 'ai_upskilling';
  const isFrameworkOverview = isFrameworkPager && suggestionPage === 0;
  const runWithCoco =
    suggestion?.kind === 'delegate' && Boolean(onRunSuggestion);
  const explanation = suggestion
    ? buildSuggestionExplanation(suggestion)
    : null;
  const frameworkOverview = suggestion
    ? buildFrameworkOverview(
        suggestion,
        suggestionToolLabel(suggestion),
        bubble.rawObservation,
      )
    : null;
  const label = bubble.agentWorking
    ? 'Working'
    : bubble.agentReply
      ? 'Reply ready'
      : isTier3
        ? 'AI Tutor'
        : bubble.invite
          ? 'Support available'
          : (STATUS_LABEL[status] ?? STATUS_LABEL.observing);

  // Rate the revealed suggestion. Logged into feedback.jsonl via the sensing
  // server so it joins observations by observation_id.
  const rate = (dir: 'up' | 'down') => {
    if (rated === dir || !suggestion) return;
    const previousRating = rated;
    setRated(dir);
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
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
    showToast(previousRating ? 'Feedback updated' : 'Thanks for the feedback');
  };

  const ratingButtons =
    suggestion && !isFrameworkOverview ? (
      <RatingButtons
        value={rated}
        onRate={rate}
        labels={{ up: 'Good suggestion', down: 'Not helpful' }}
        className="coco-rating--compact"
      />
    ) : null;

  return (
    <div
      className={`observation-bubble status-${status}${fadingOut ? ' is-leaving' : ''}${isTier3 ? ' is-tier3' : ''}${suggestion ? ' has-suggestion' : ''}${isFrameworkOverview ? ' is-framework-overview' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="observation-bubble-header">
        <div className="observation-bubble-label">
          {/* eslint-disable-next-line no-nested-ternary */}
          {isFrameworkOverview
            ? (explanation?.competency ?? '4D framework')
            : suggestion
              ? suggestion.title
              : label}
        </div>

        {onDismiss && (
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
      </div>

      {/* eslint-disable-next-line no-nested-ternary */}
      {isFrameworkOverview && explanation ? (
        <div className="bubble-framework-overview">
          {explanation.sentences.map((sentence, index) => (
            <div
              key={sentence}
              className={`bubble-why-line${index === 0 ? ' bubble-why-line--lead' : ''}`}
            >
              {sentence}
            </div>
          ))}
        </div>
      ) : isFrameworkOverview && suggestion ? (
        <div className="bubble-framework-overview">
          <div className="bubble-framework-heading">
            {frameworkOverview?.heading}
          </div>
          {frameworkOverview?.concepts.map((concept) => (
            <div className="bubble-framework-concept" key={concept.term}>
              <span className="bubble-framework-term">{concept.term}</span>
              <span>{concept.explanation}</span>
            </div>
          ))}
        </div>
      ) : suggestion ? (
        <div className="observation-bubble-text observation-suggestion-body">
          {suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body}
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

      {suggestion && !isFrameworkOverview && (
        <div className="bubble-tool-actions">
          <button
            type="button"
            className="bubble-action-btn bubble-chat-action"
            onClick={runWithCoco ? onRunSuggestion : onChatAboutSuggestion}
          >
            {runWithCoco ? 'Run with Coco' : 'Chat with Coco'}
          </button>
        </div>
      )}

      {/* Rate the suggestion; the opposite choice stays editable. */}
      {ratingButtons && !isFrameworkPager && (
        <div className="bubble-feedback-row">{ratingButtons}</div>
      )}

      {isFrameworkPager && (
        <div className="bubble-framework-pager" aria-label="Suggestion pages">
          {ratingButtons && (
            <div className="bubble-pager-rating">{ratingButtons}</div>
          )}
          <div className="bubble-framework-page-bars" aria-hidden="true">
            <span
              className={`bubble-framework-page-bar${suggestionPage === 0 ? ' is-active' : ''}`}
            />
            <span
              className={`bubble-framework-page-bar${suggestionPage === 1 ? ' is-active' : ''}`}
            />
          </div>
          <button
            type="button"
            className="bubble-framework-arrow"
            onClick={() => setSuggestionPage(suggestionPage === 0 ? 1 : 0)}
          >
            {suggestionPage === 0 ? 'Show me how →' : '← Why'}
          </button>
        </div>
      )}

      {isTier3 && (
        <button
          type="button"
          className="bubble-action-btn"
          onClick={onViewConversation}
        >
          {bubble.agentWorking
            ? 'View progress →'
            : bubble.agentReply
              ? 'View reply →'
              : 'View conversation →'}
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
