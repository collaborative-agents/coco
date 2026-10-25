import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { InstantSuggestion } from './observation-types';
import RatingButtons from './RatingButtons';
import {
  buildFrameworkOverview,
  buildSuggestionExplanation,
} from './framework-overview';

type VizState = 'none' | 'success' | 'error';
type NotifType =
  | 'default'
  | 'daily-summary'
  | 'proactive-suggestion'
  | 'instant-suggestion'
  | 'session-start-prompt'
  | 'session-end-prompt';

interface NotificationPayload {
  notificationId?: string;
  message: string;
  actionLabel?: string;
  cancelLabel?: string;
  vizState?: VizState;
  notifType?: NotifType;
  observationId?: string;
  status?: string;
  rawObservation?: string;
  suggestion?: InstantSuggestion;
  adjustable?: boolean;
  scenario?: string;
  /** Pre-session invite; acting on its suggestion starts the session. */
  sessionInvite?: boolean;
}

function suggestionToolLabel(suggestion: InstantSuggestion): string {
  const preferred = (suggestion.availableTools ?? []).find(
    (tool) => tool.id === suggestion.targetTool,
  );
  if (preferred) return preferred.label;
  if (suggestion.availableTools?.[0]) return suggestion.availableTools[0].label;
  return 'an AI tool';
}

// ── Tutor JSON parsing ────────────────────────────────────────────────────────
// The tutor backend sometimes sends a JSON envelope like:
//   {"guidance": "...", "visualization_url": null, ...}
// rather than plain markdown.  Extract the text guidance so the bubble always
// shows readable prose, never raw JSON.

/** Scan for the first balanced {...} block, respecting strings and escapes. */
function extractJsonObject(text: string): string | null {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/**
 * LLMs embed LaTeX (\frac, \theta …) inside JSON strings without escaping.
 * Repair those invalid escape sequences before attempting JSON.parse().
 */
function repairJsonEscapes(text: string): string {
  const structural = new Set(['"', '\\', '/']);
  const ambiguous = new Set(['b', 'f', 'n', 'r', 't']);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const nxt = text[i + 1];
      if (structural.has(nxt)) { out.push(text[i], nxt); i += 2; continue; }
      if (nxt === 'u' && i + 5 < text.length && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out.push(text.slice(i, i + 6)); i += 6; continue;
      }
      if (ambiguous.has(nxt)) {
        const after = i + 2 < text.length ? text[i + 2] : '';
        if (/[a-zA-Z]/.test(after)) {
          out.push('\\\\'); i += 1; continue; // LaTeX-like: \frac, \theta …
        } else {
          out.push(text[i], nxt); i += 2; continue; // Genuine \n, \t
        }
      }
      out.push('\\\\'); i += 1; continue; // Invalid escape — double-escape
    }
    out.push(text[i]); i += 1;
  }
  return out.join('');
}

/**
 * If `raw` is (or contains) a tutor JSON envelope, return the text guidance
 * string inside it.  Supports both key formats used by the tutor backend:
 *   - new format: { "guidance": "…" }
 *   - old format: { "Text guidance": "…" }
 * Returns null if no JSON envelope is detected.
 */
function extractGuidanceText(raw: string): string | null {
  const tryParse = (s: string): string | null => {
    let obj: any = null;
    try { obj = JSON.parse(s); } catch {
      try { obj = JSON.parse(repairJsonEscapes(s)); } catch { return null; }
    }
    if (obj && typeof obj === 'object') {
      const text = obj['guidance'] ?? obj['Text guidance'] ?? null;
      return text != null ? String(text) : null;
    }
    return null;
  };

  // 1. Direct parse
  const direct = tryParse(raw.trim());
  if (direct !== null) return direct;

  // 2. JSON inside a ```json … ``` fence
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  // 3. JSON embedded after prose
  const extracted = extractJsonObject(raw);
  if (extracted) {
    const parsed = tryParse(extracted);
    if (parsed !== null) return parsed;
  }

  return null;
}

/** Return the display-ready message: guidance text if JSON, otherwise the raw string. */
function resolveMessage(raw: string): string {
  return extractGuidanceText(raw) ?? raw;
}

/**
 * Truncate a long guidance message to a preview.
 * Cuts at a word boundary near `maxChars` and appends "…" so the toast
 * stays readable without scrolling for lengthy tutor guidance.
 */
// Matches .notification-root's padding in App.css.
const NOTIFICATION_ROOT_PADDING = 8;

const PREVIEW_CHARS = 180;
function truncateForPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const cutoff = text.lastIndexOf(' ', PREVIEW_CHARS);
  const end = cutoff > 60 ? cutoff : PREVIEW_CHARS;
  return text.slice(0, end) + '…';
}

// ── Markdown renderer config ──────────────────────────────────────────────────
// Custom react-markdown renderers:
//  - <a>: open external links in the system browser via shell, not
//    inside this transparent BrowserWindow.
const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  a({ href, children, ...props }: any) {
    return (
      <a href={href} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

export function NotificationBubble({
  message,
  actionLabel,
  cancelLabel,
  notifType,
  onAction,
  onCancel,
  onDismiss,
  onHoverChange,
  suggestion,
  onChatAboutSuggestion,
  onRunSuggestion,
  suggestionRating,
  onRateSuggestion,
  adjustable,
  expanded,
  onToggleExpanded,
  showFrameworkIntro,
  frameworkPage = 0,
  onFrameworkPageChange,
  rawObservation,
}: {
  message: string;
  actionLabel?: string;
  cancelLabel?: string;
  notifType?: NotifType;
  onAction?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  suggestion?: InstantSuggestion;
  onChatAboutSuggestion?: () => void;
  onRunSuggestion?: () => void;
  suggestionRating?: 'up' | 'down' | null;
  onRateSuggestion?: (rating: 'up' | 'down') => void;
  adjustable?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  showFrameworkIntro?: boolean;
  frameworkPage?: 0 | 1;
  onFrameworkPageChange?: (page: 0 | 1) => void;
  rawObservation?: string;
}) {
  const isSessionInvite = notifType === 'session-start-prompt';
  const isPrompt = isSessionInvite || notifType === 'session-end-prompt';
  const isSuggestionPreview =
    notifType === 'proactive-suggestion' && suggestion != null;
  const isRevealedSuggestion =
    notifType === 'instant-suggestion' && suggestion != null;
  const isFrameworkPager = showFrameworkIntro && suggestion != null;
  const isFrameworkOverview = isFrameworkPager && frameworkPage === 0;
  const runWithCoco =
    suggestion?.kind === 'delegate' && Boolean(onRunSuggestion);
  const explanation = suggestion
    ? buildSuggestionExplanation(suggestion)
    : null;
  const frameworkOverview = suggestion
    ? buildFrameworkOverview(
        suggestion,
        suggestionToolLabel(suggestion),
        rawObservation,
      )
    : null;

  const ratingButtons = isRevealedSuggestion ? (
    <RatingButtons
      value={suggestionRating}
      onRate={(rating) => onRateSuggestion?.(rating)}
      labels={{ up: 'Good suggestion', down: 'Not helpful' }}
    />
  ) : null;
  // Without the page row, the thumbs lead the footer instead.
  const footerRating =
    ratingButtons && !isFrameworkPager ? (
      <div className="toast-footer-rating">{ratingButtons}</div>
    ) : null;

  // For default pause-event guidance, truncate to a short preview so the
  // card doesn't overflow with a multi-paragraph response.
  const resolvedMessage = resolveMessage(message);
  const displayMessage =
    expanded ||
    isPrompt ||
    notifType === 'instant-suggestion' ||
    notifType === 'daily-summary'
      ? resolvedMessage
      : truncateForPreview(resolvedMessage);

  return (
    <div
      className={`toast-card${isPrompt ? ' toast-card--compact' : ''}${
        isSuggestionPreview ? ' toast-card--suggestion-preview' : ''
      }${isFrameworkOverview ? ' toast-card--framework-overview' : ''}${
        isFrameworkPager && !isFrameworkOverview
          ? ' toast-card--suggestion-action'
          : ''
      }${isFrameworkPager ? ' toast-card--fit' : ''}`}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="toast-header">
        <div className="toast-brand">
          <span className="toast-brand-dot" />
          <span className="toast-brand-name">Coco</span>
        </div>
        <div className="toast-header-actions">
          {adjustable && !isSuggestionPreview && (
            <button
              type="button"
              className="toast-window-control"
              onClick={onToggleExpanded}
              aria-label={
                expanded ? 'Collapse notification' : 'Expand notification'
              }
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '↙' : '↗'}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>

      <div className="toast-body">
        {(isSuggestionPreview || isFrameworkPager) && !isFrameworkOverview && (
          <div className="toast-suggestion-label">
            <span aria-hidden="true">✦</span>
            <span>{isFrameworkPager ? 'Try this' : 'Suggestion'}</span>
          </div>
        )}
        {isSessionInvite && (
          <div className="toast-suggestion-label">
            <span aria-hidden="true">✦</span>
            <span>Support available</span>
          </div>
        )}
        {/* eslint-disable-next-line no-nested-ternary */}
        {isFrameworkOverview && explanation ? (
          <div className="toast-framework-overview">
            <div className="toast-framework-eyebrow">
              {explanation.competency ?? '4D framework'}
            </div>
            {explanation.sentences.map((sentence, index) => (
              <div
                key={sentence}
                className={`toast-why-line${index === 0 ? ' toast-why-line--lead' : ''}`}
              >
                {sentence}
              </div>
            ))}
          </div>
        ) : isFrameworkOverview && suggestion ? (
          <div className="toast-framework-overview">
            <div className="toast-framework-eyebrow">4D framework</div>
            <div className="toast-framework-heading">
              {frameworkOverview?.heading}
            </div>
            {frameworkOverview?.concepts.map((concept) => (
              <div className="toast-framework-concept" key={concept.term}>
                <span className="toast-framework-term">{concept.term}</span>
                <span>{concept.explanation}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="toast-message toast-markdown">
            <Markdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={markdownComponents}
            >
              {displayMessage}
            </Markdown>
          </div>
        )}
      </div>

      {/* Two-button layout for proactive prompts; single action for tutor guidance */}
      {isPrompt ? (
        <div className="toast-footer toast-footer-prompt">
          {cancelLabel && (
            <button type="button" className="toast-cancel" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          {actionLabel && (
            <button type="button" className="toast-action" onClick={onAction}>
              {actionLabel}
            </button>
          )}
        </div>
      ) : isRevealedSuggestion ? (
        <div className="toast-footer">
          {footerRating}
          <button
            type="button"
            className="toast-action toast-chat-action"
            onClick={runWithCoco ? onRunSuggestion : onChatAboutSuggestion}
          >
            {runWithCoco ? 'Run with Coco' : 'Chat with Coco'}
          </button>
        </div>
      ) : (
        actionLabel && (
          <div className="toast-footer">
            {footerRating}
            <button type="button" className="toast-action" onClick={onAction}>
              {`${actionLabel} →`}
            </button>
          </div>
        )
      )}

      {isFrameworkPager && (
        <div className="toast-framework-pager" aria-label="Suggestion pages">
          {/* Thumbs sit opposite the page arrow so the footer holds only actions. */}
          {ratingButtons && (
            <div className="toast-pager-rating">{ratingButtons}</div>
          )}
          <div className="toast-framework-page-bars" aria-hidden="true">
            <span
              className={`toast-framework-page-bar${frameworkPage === 0 ? ' is-active' : ''}`}
            />
            <span
              className={`toast-framework-page-bar${frameworkPage === 1 ? ' is-active' : ''}`}
            />
          </div>
          <button
            type="button"
            className="toast-framework-arrow"
            onClick={() => onFrameworkPageChange?.(frameworkPage === 0 ? 1 : 0)}
          >
            {frameworkPage === 0 ? 'Show me how →' : '← Why'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function NotificationView() {
  const [visible, setVisible] = useState(false);
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [suggestionRating, setSuggestionRating] = useState<
    'up' | 'down' | null
  >(null);
  const [expanded, setExpanded] = useState(false);
  const [frameworkPage, setFrameworkPage] = useState<0 | 1>(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'notification',
      (data: any) => {
        const incoming = data as NotificationPayload | undefined;
        if (
          incoming?.notifType === 'proactive-suggestion' &&
          incoming.scenario === 'ai_upskilling' &&
          incoming.suggestion
        ) {
          // Main already locks when creating this first framework page. Repeat
          // the signal as a renderer handshake so the lock also survives any
          // future alternate window-creation path.
          window.electron?.ipcRenderer.sendMessage(
            'proactive-suggestion-open-state',
            { open: true },
          );
        }
        setPayload({
          message: String(incoming?.message ?? ''),
          actionLabel: incoming?.actionLabel
            ? String(incoming.actionLabel)
            : undefined,
          cancelLabel: incoming?.cancelLabel
            ? String(incoming.cancelLabel)
            : undefined,
          vizState:
            incoming?.vizState === 'success' || incoming?.vizState === 'error'
              ? incoming.vizState
              : 'none',
          notifType: incoming?.notifType ?? 'default',
          observationId: incoming?.observationId,
          status: incoming?.status,
          rawObservation: incoming?.rawObservation,
          suggestion: incoming?.suggestion,
          adjustable: incoming?.adjustable === true,
          scenario: incoming?.scenario,
          notificationId: incoming?.notificationId,
          sessionInvite: incoming?.sessionInvite === true,
        });
        setLoadingSuggestion(false);
        setSuggestionRating(null);
        setExpanded(false);
        setFrameworkPage(0);
        setVisible(true);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // AI-upskilling suggestion pages vary in length. Fit the window to the card
  // rather than leaving empty space, which would also block clicks below it.
  const fitsToContent =
    visible && payload?.scenario === 'ai_upskilling' && payload.suggestion;
  useLayoutEffect(() => {
    if (!fitsToContent || expanded) return undefined;
    const fit = () => {
      const card = rootRef.current?.querySelector<HTMLElement>('.toast-card');
      if (!card) return;
      const contentHeight = Array.from(card.children).reduce(
        (total, child) =>
          total +
          Math.max((child as HTMLElement).offsetHeight, child.scrollHeight),
        0,
      );
      window.electron?.ipcRenderer.sendMessage('fit-notification-height', {
        // The root's padding keeps the card's shadow inside the window.
        height: Math.ceil(contentHeight + NOTIFICATION_ROOT_PADDING * 2),
      });
    };
    fit();
    // Markdown and fonts can settle a frame later.
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fitsToContent, payload, frameworkPage, expanded]);

  if (!visible || !payload) return null;

  const ipc = window.electron?.ipcRenderer;
  const reportResponse = (outcome: 'accepted' | 'dismissed') => {
    if (!payload.notificationId) return;
    ipc?.sendMessage('notification-response', {
      notificationId: payload.notificationId,
      outcome,
    });
  };

  const rateInstantSuggestion = (rating: 'up' | 'down') => {
    if (
      suggestionRating === rating ||
      !payload.observationId ||
      !payload.suggestion
    ) {
      return;
    }
    const previousRating = suggestionRating;
    setSuggestionRating(rating);
    const ratedAt = Math.floor(Date.now() / 1000);
    ipc?.sendMessage('activity-support-rated', {
      observationId: payload.observationId,
      rating,
      ratedAt,
    });
    ipc?.sendMessage('training-feedback', {
      kind: rating === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
      surface: 'notification',
      observation_id: payload.observationId,
      status: payload.status,
      text: payload.suggestion.copyText ?? null,
    });
  };

  const handleAction = async () => {
    if (payload.notifType === 'proactive-suggestion' && loadingSuggestion) {
      return;
    }
    // An invite's preview is accepted only by chatting about it; reading it
    // and closing with "Got it" declines the session.
    if (payload.sessionInvite && payload.notifType === 'instant-suggestion') {
      reportResponse('dismissed');
    } else if (
      !payload.sessionInvite ||
      payload.notifType === 'session-start-prompt'
    ) {
      reportResponse('accepted');
    }
    if (payload.notifType === 'session-start-prompt') {
      // Main starts the session, opens the chat, and destroys this window.
      ipc?.sendMessage('session-invite-accepted');
      setVisible(false);
      return;
    }
    if (payload.notifType === 'session-end-prompt') {
      // Ask main to show the rating window.
      ipc?.sendMessage('proactive-session-end-confirmed');
      setVisible(false);
      return;
    }
    if (payload.notifType === 'proactive-suggestion') {
      // Lock immediately on click, before awaiting a cached/in-flight
      // suggestion. Otherwise an observation arriving during that await can
      // replace the notification the user is actively opening.
      ipc?.sendMessage('proactive-suggestion-open-state', { open: true });
      let suggestion = payload.suggestion;
      if (!suggestion) {
        setLoadingSuggestion(true);
        const result = await ipc?.invoke('get-instant-suggestion', {
          observationId: payload.observationId,
        });
        setLoadingSuggestion(false);
        suggestion =
          result?.status === 'ready'
            ? (result.suggestion as InstantSuggestion)
            : undefined;
      }
      if (suggestion) {
        const detail =
          suggestion.kind === 'delegate'
            ? suggestion.prompt
            : suggestion.body;
        setPayload({
          ...payload,
          message: `**${suggestion.title}**\n\n${detail ?? suggestion.copyText}`,
          actionLabel: suggestion.kind === 'content' ? 'Got it' : undefined,
          notifType: 'instant-suggestion',
          suggestion,
        });
        if (payload.sessionInvite) {
          ipc?.sendMessage('session-invite-revealed', {
            inviteId: payload.notificationId,
          });
        }
        const engagedAt = Math.floor(Date.now() / 1000);
        ipc?.sendMessage('activity-support-engaged', {
          observationId: payload.observationId,
          engagedAt,
          suggestion,
          destination: 'inline',
        });
        ipc?.sendMessage('training-feedback', {
          kind: 'engage',
          surface: 'notification',
          observation_id: payload.observationId ?? null,
          status: payload.status,
          text: payload.rawObservation ?? null,
        });
        return;
      }
      // Preserve the existing chat route as a cache-miss/error fallback.
      ipc?.sendMessage('open-notification-suggestion', {
        observationId: payload.observationId,
        status: payload.status,
        rawObservation: payload.rawObservation,
      });
      setVisible(false);
      return;
    }
    if (payload.notifType === 'instant-suggestion') {
      // "Got it" on coaching text: reported above and closed. It is
      // not a rating; the thumbs record whether it helped.
      setVisible(false);
      window.close();
      return;
    }
    // Default: open the main window (existing tutor guidance behaviour).
    ipc?.sendMessage('open-main-window');
    setVisible(false);
    window.close();
  };

  const handleCancel = () => {
    reportResponse('dismissed');
    setVisible(false);
    window.close();
  };

  const handleFrameworkPageChange = async (page: 0 | 1) => {
    setFrameworkPage(page);
    if (page === 1 && payload.notifType === 'proactive-suggestion') {
      await handleAction();
    }
  };

  const recordUnengagedDismissal = () => {
    if (
      payload.notifType !== 'proactive-suggestion' ||
      !payload.observationId
    ) {
      return;
    }
    ipc?.sendMessage('training-feedback', {
      kind: 'dismiss',
      surface: 'notification',
      observation_id: payload.observationId,
      status: payload.status,
      text: payload.rawObservation ?? null,
    });
  };

  const handleDismiss = () => {
    reportResponse('dismissed');
    recordUnengagedDismissal();
    setVisible(false);
    window.close();
  };

  const handleHoverChange = (hovered: boolean) => {
    ipc?.sendMessage('notification-hover-state', { hovered });
  };

  const handleToggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    ipc?.sendMessage('set-notification-expanded', {
      expanded: nextExpanded,
    });
  };

  const handleChatAboutSuggestion = (execute = false) => {
    if (!payload.suggestion) return;
    reportResponse('accepted');
    ipc?.sendMessage('chat-about-suggestion', {
      execute,
      observationId: payload.observationId,
      status: payload.status,
      rawObservation: payload.rawObservation,
      suggestion: payload.suggestion,
      surface: 'notification',
      sessionInvite: payload.sessionInvite,
    });
    setVisible(false);
    window.close();
  };

  return (
    <div className="notification-root" ref={rootRef}>
      <NotificationBubble
        message={payload.message}
        actionLabel={
          loadingSuggestion ? 'Preparing suggestion…' : payload.actionLabel
        }
        cancelLabel={payload.cancelLabel}
        notifType={payload.notifType}
        onAction={handleAction}
        onCancel={handleCancel}
        onDismiss={handleDismiss}
        onHoverChange={handleHoverChange}
        suggestion={payload.suggestion}
        onChatAboutSuggestion={() => handleChatAboutSuggestion()}
        onRunSuggestion={() => handleChatAboutSuggestion(true)}
        suggestionRating={suggestionRating}
        onRateSuggestion={rateInstantSuggestion}
        adjustable={payload.adjustable}
        expanded={expanded}
        onToggleExpanded={handleToggleExpanded}
        showFrameworkIntro={
          payload.scenario === 'ai_upskilling' && payload.suggestion != null
        }
        frameworkPage={frameworkPage}
        onFrameworkPageChange={handleFrameworkPageChange}
        rawObservation={payload.rawObservation}
      />
    </div>
  );
}
