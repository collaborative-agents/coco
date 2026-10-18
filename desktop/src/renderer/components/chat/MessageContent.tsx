import React, { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatSuggestionText } from '../../../shared/chat-suggestion';
import type { ChatSuggestion } from '../../../shared/chat-suggestion';
import { buildSuggestionExplanation } from '../framework-overview';
import type { ChatMessage } from './types';
import { parseGuidance, makeMessageId } from './message-format';
import { S } from './styles';
import './MessageContent.css';

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] =
  {
    a({ href, children, ...props }: any) {
      return (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
          {children}
        </a>
      );
    },
  };

// ── Message model ──────────────────────────────────────────────────────────────
export function TutorMessage({ text }: { text: string }) {
  const g = parseGuidance(text);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const copyPrompt = async () => {
    if (!g.examplePrompt) return;
    try {
      await navigator.clipboard.writeText(g.examplePrompt);
      setCopiedPrompt(g.examplePrompt);
      setCopyError('');
    } catch {
      setCopyError(
        'Could not copy. Select the prompt text to copy it manually.',
      );
    }
  };
  const competency = g.competency
    ? g.competency.charAt(0).toUpperCase() + g.competency.slice(1)
    : null;
  return (
    <div className="tutor-response">
      {(g.mainText ?? g.text) && (
        <div className="chat-markdown tutor-main-answer">
          <Markdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={markdownComponents}
          >
            {g.mainText ?? g.text}
          </Markdown>
        </div>
      )}
      {g.examplePrompt && (
        <section className="tutor-prompt-card" aria-label="Suggested prompt">
          <div className="tutor-prompt-header">
            <span className="tutor-section-label">Try this prompt</span>
            <button
              type="button"
              className="tutor-copy-prompt"
              onClick={copyPrompt}
            >
              {copiedPrompt === g.examplePrompt ? 'Copied ✓' : 'Copy prompt'}
            </button>
          </div>
          <div className="tutor-prompt-text">{g.examplePrompt}</div>
          <span className="tutor-copy-status" role="status">
            {copiedPrompt === g.examplePrompt
              ? 'Prompt copied to clipboard.'
              : ''}
          </span>
          {copyError && (
            <p className="tutor-copy-error" role="alert">
              {copyError}
            </p>
          )}
        </section>
      )}
      {g.vizCode && (
        <figure className="tutor-visualization">
          <figcaption className="tutor-section-label">Visualization</figcaption>
          <iframe
            title="Coco visualization"
            sandbox="allow-scripts"
            srcDoc={g.vizCode}
          />
        </figure>
      )}
      {g.coaching && (
        <aside
          className="tutor-literacy-card"
          aria-label="Suggestion"
        >
          <div className="tutor-literacy-header">
            <span className="tutor-literacy-title">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path
                  d="M7 14h6M8 17h4M7 12c0-2-3-2.5-3-6a6 6 0 0 1 12 0c0 3.5-3 4-3 6"
                  transform="translate(0 1) scale(1 .9)"
                  strokeLinecap="round"
                />
              </svg>
              Suggestion
            </span>
            {competency && (
              <span
                className="tutor-literacy-skill"
                aria-label={`AI skill: ${competency}`}
              >
                {competency}
              </span>
            )}
          </div>
          <div className="chat-markdown">
            <Markdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={markdownComponents}
            >
              {g.coaching}
            </Markdown>
          </div>
        </aside>
      )}
    </div>
  );
}

export function suggestionMessage(
  suggestion: ChatSuggestion,
  folded: boolean,
): ChatMessage {
  return {
    role: 'tutor',
    text: chatSuggestionText(suggestion),
    id: makeMessageId(),
    ts: Date.now(),
    suggestion,
    folded,
  };
}

// A proactive suggestion shown as a Coco message. Folded, only the title shows.
export function SuggestionMessage({
  suggestion,
  folded,
  onToggleFold,
  onRun,
  runDisabled,
}: {
  suggestion: ChatSuggestion;
  folded: boolean;
  onToggleFold: () => void;
  onRun?: () => void;
  runDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const ipc = window.electron?.ipcRenderer;
  const detail =
    (suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body) ||
    suggestion.copyText;
  const explanation = buildSuggestionExplanation(suggestion);
  const copyPrompt = () => {
    ipc?.sendMessage('suggestion-action', { copyText: suggestion.copyText });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={S.tutorBubble}>
      <div style={S.suggestionHeader}>
        <span style={S.suggestionLabel}>
          ✦ Suggestion
          {explanation?.competency ? ` · ${explanation.competency}` : ''}
        </span>
        <button
          type="button"
          style={S.suggestionFoldBtn}
          aria-expanded={!folded}
          onClick={onToggleFold}
        >
          {folded ? 'Show ▾' : 'Hide ▴'}
        </button>
      </div>
      {onRun && (
        <button
          type="button"
          style={S.exampleBtn}
          disabled={runDisabled}
          onClick={onRun}
        >
          Run with Coco
        </button>
      )}
      {/* Unfolded, the card shows the pop-up's two pages: why, then the action. */}
      {!folded &&
        explanation?.sentences.map((sentence, index) => (
          <div
            key={sentence}
            style={index === 0 ? S.suggestionWhyLead : S.suggestionWhy}
          >
            {sentence}
          </div>
        ))}
      <div
        style={{
          ...S.suggestionTitle,
          ...(!folded && explanation ? S.suggestionActionTitle : {}),
        }}
      >
        {suggestion.title}
      </div>
      {!folded &&
        (suggestion.kind === 'delegate' ? (
          <div style={S.example}>
            <div style={S.suggestionPrompt}>{detail}</div>
            <div style={S.suggestionActions}>
              <button type="button" style={S.exampleBtn} onClick={copyPrompt}>
                {copied ? 'Copied ✓' : 'Copy prompt'}
              </button>
              {suggestion.tool && (
                <button
                  type="button"
                  style={S.exampleBtn}
                  onClick={() =>
                    ipc?.sendMessage('suggestion-action', {
                      toolId: suggestion.tool?.id,
                      copyText: suggestion.copyText,
                    })
                  }
                >
                  Open {suggestion.tool.label}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="chat-markdown">
            <Markdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={markdownComponents}
            >
              {detail}
            </Markdown>
          </div>
        ))}
    </div>
  );
}
