import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { InstantSuggestion } from './observation-types';
import {
  buildFrameworkOverview,
  frameworkNavigationLabel,
} from './framework-overview';

type VizState = 'none' | 'success' | 'error';
type NotifType =
  | 'default'
  | 'proactive-suggestion'
  | 'instant-suggestion'
  | 'session-start-prompt'
  | 'session-end-prompt';

interface NotificationPayload {
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
  onSuggestionAction,
  onChatAboutSuggestion,
  onOpenCocoChat,
  suggestionRating,
  onRateSuggestion,
  copyConfirmed,
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
  onSuggestionAction?: (toolId: string | null) => void;
  onChatAboutSuggestion?: () => void;
  onOpenCocoChat?: () => void;
  suggestionRating?: 'up' | 'down' | null;
  onRateSuggestion?: (rating: 'up' | 'down') => void;
  copyConfirmed?: boolean;
  adjustable?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  showFrameworkIntro?: boolean;
  frameworkPage?: 0 | 1;
  onFrameworkPageChange?: (page: 0 | 1) => void;
  rawObservation?: string;
}) {
  const isPrompt =
    notifType === 'session-start-prompt' || notifType === 'session-end-prompt';
  const isSuggestionPreview =
    notifType === 'proactive-suggestion' && suggestion != null;
  const isRevealedSuggestion =
    notifType === 'instant-suggestion' && suggestion != null;
  const isFrameworkPager = showFrameworkIntro && suggestion != null;
  const isFrameworkOverview = isFrameworkPager && frameworkPage === 0;
  const suggestedTool = suggestion
    ? preferredSuggestionTool(suggestion)
    : undefined;
  const frameworkOverview = suggestion
    ? buildFrameworkOverview(
        suggestion,
        suggestionToolLabel(suggestion),
        rawObservation,
      )
    : null;

  // For default pause-event guidance, truncate to a short preview so the
  // card doesn't overflow with a multi-paragraph response.
  const resolvedMessage = resolveMessage(message);
  const displayMessage =
    expanded || isPrompt || notifType === 'instant-suggestion'
      ? resolvedMessage
      : truncateForPreview(resolvedMessage);

  return (
    <div
      className={`toast-card${isPrompt ? ' toast-card--compact' : ''}${
        isSuggestionPreview ? ' toast-card--suggestion-preview' : ''
      }${isFrameworkOverview ? ' toast-card--framework-overview' : ''}`}
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
        {isSuggestionPreview && !isFrameworkOverview && (
          <div className="toast-suggestion-label">
            <span aria-hidden="true">✦</span>
            <span>Suggestion</span>
          </div>
        )}
        {isFrameworkOverview && suggestion ? (
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
      ) : isRevealedSuggestion && suggestion.kind === 'delegate' ? (
        <div className="toast-footer toast-tool-actions">
          <div className="toast-rating-actions">
            {(['up', 'down'] as const).map((rating) => (
              <button
                key={rating}
                type="button"
                className={`toast-rating-btn${
                  suggestionRating === rating ? ' is-rated' : ''
                }`}
                aria-label={rating === 'up' ? 'Good suggestion' : 'Not helpful'}
                disabled={suggestionRating === rating}
                onClick={() => onRateSuggestion?.(rating)}
              >
                {rating === 'up' ? '👍' : '👎'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="toast-action toast-coco-chat-action"
            onClick={onOpenCocoChat}
            autoFocus
          >
            Open Coco Chat
          </button>
          <button
            type="button"
            className="toast-action"
            onClick={() => onSuggestionAction?.(null)}
            disabled={copyConfirmed}
          >
            {copyConfirmed ? 'Copied ✓' : 'Copy prompt'}
          </button>
          <button
            type="button"
            className="toast-action toast-chat-action"
            onClick={onChatAboutSuggestion}
          >
            Chat about it
          </button>
          {suggestedTool && (
            <button
              type="button"
              className="toast-action toast-tool-action"
              onClick={() => onSuggestionAction?.(suggestedTool.id)}
            >
              Open {suggestedTool.label}
            </button>
          )}
        </div>
      ) : (
        actionLabel && (
          <div className="toast-footer">
            {isRevealedSuggestion && (
              <div className="toast-rating-actions">
                {(['up', 'down'] as const).map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className={`toast-rating-btn${
                      suggestionRating === rating ? ' is-rated' : ''
                    }`}
                    aria-label={
                      rating === 'up' ? 'Good suggestion' : 'Not helpful'
                    }
                    disabled={suggestionRating === rating}
                    onClick={() => onRateSuggestion?.(rating)}
                  >
                    {rating === 'up' ? '👍' : '👎'}
                  </button>
                ))}
              </div>
            )}
            {isRevealedSuggestion && (
              <button
                type="button"
                className="toast-action toast-chat-action"
                onClick={onChatAboutSuggestion}
              >
                Chat about it
              </button>
            )}
            <button type="button" className="toast-action" onClick={onAction}>
              {actionLabel} →
            </button>
          </div>
        )
      )}

      {isFrameworkPager && (
        <div className="toast-framework-pager" aria-label="Suggestion pages">
          <div className="toast-framework-page-bars" aria-hidden="true">
            <span className={`toast-framework-page-bar${frameworkPage === 0 ? ' is-active' : ''}`} />
            <span className={`toast-framework-page-bar${frameworkPage === 1 ? ' is-active' : ''}`} />
          </div>
          <button
            type="button"
            className="toast-framework-arrow"
            aria-label={frameworkNavigationLabel(suggestion, frameworkPage)}
            onClick={() => onFrameworkPageChange?.(frameworkPage === 0 ? 1 : 0)}
          >
            {frameworkPage === 0 ? '→' : '←'}
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
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [frameworkPage, setFrameworkPage] = useState<0 | 1>(0);

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
        });
        setLoadingSuggestion(false);
        setSuggestionRating(null);
        setCopyConfirmed(false);
        setExpanded(false);
        setFrameworkPage(0);
        setVisible(true);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  if (!visible || !payload) return null;

  const ipc = window.electron?.ipcRenderer;

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
    if (payload.notifType === 'session-start-prompt') {
      // Ask main to show the mini session-setup window.
      ipc?.sendMessage('show-session-setup');
      setVisible(false);
      // Don't close — main will destroy this window after showing setup.
      return;
    }
    if (payload.notifType === 'session-end-prompt') {
      // Ask main to show the rating window.
      ipc?.sendMessage('proactive-session-end-confirmed');
      setVisible(false);
      return;
    }
    if (payload.notifType === 'proactive-suggestion') {
      if (loadingSuggestion) return;
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
          actionLabel: suggestion.kind === 'content' ? 'Copy' : undefined,
          notifType: 'instant-suggestion',
          suggestion,
        });
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
      ipc?.sendMessage('suggestion-action', {
        copyText: payload.suggestion?.copyText,
      });
      rateInstantSuggestion('up');
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

  const handleSuggestionAction = (toolId: string | null) => {
    ipc?.sendMessage('suggestion-action', {
      toolId,
      copyText: payload.suggestion?.copyText,
    });
    if (toolId === null) {
      rateInstantSuggestion('up');
      setCopyConfirmed(true);
      return;
    }
    setVisible(false);
    window.close();
  };

  const handleChatAboutSuggestion = () => {
    if (!payload.suggestion) return;
    ipc?.sendMessage('chat-about-suggestion', {
      observationId: payload.observationId,
      status: payload.status,
      rawObservation: payload.rawObservation,
      suggestion: payload.suggestion,
      surface: 'notification',
    });
    setVisible(false);
    window.close();
  };

  const handleOpenCocoChat = () => {
    if (!payload.suggestion) return;
    ipc?.sendMessage('chat-about-suggestion', {
      observationId: payload.observationId,
      status: payload.status,
      rawObservation: payload.rawObservation,
      suggestion: payload.suggestion,
      surface: 'notification',
      copyPromptToInput: true,
    });
    setVisible(false);
    window.close();
  };

  return (
    <div className="notification-root">
      <NotificationBubble
        message={payload.message}
        actionLabel={loadingSuggestion ? 'Preparing suggestion…' : payload.actionLabel}
        cancelLabel={payload.cancelLabel}
        notifType={payload.notifType}
        onAction={handleAction}
        onCancel={handleCancel}
        onDismiss={handleDismiss}
        onHoverChange={handleHoverChange}
        suggestion={payload.suggestion}
        onSuggestionAction={handleSuggestionAction}
        onChatAboutSuggestion={handleChatAboutSuggestion}
        onOpenCocoChat={handleOpenCocoChat}
        suggestionRating={suggestionRating}
        onRateSuggestion={rateInstantSuggestion}
        copyConfirmed={copyConfirmed}
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
