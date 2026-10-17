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
  return (
    <div>
      <div className="chat-markdown">
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={markdownComponents}
        >
          {g.text}
        </Markdown>
      </div>
      {g.vizCode && (
        // eslint-disable-next-line react/no-danger-with-children
        <iframe
          title="visualization"
          style={S.viz}
          sandbox="allow-scripts"
          srcDoc={g.vizCode}
        />
      )}
      {g.examplePrompt && (
        <div style={S.example}>
          <div style={{ fontWeight: 600, marginBottom: 2, color: '#3355cc' }}>
            Try this prompt
          </div>
          {g.examplePrompt}
          <div>
            <button
              type="button"
              style={S.exampleBtn}
              onClick={() =>
                navigator.clipboard.writeText(g.examplePrompt || '')
              }
            >
              Copy prompt
            </button>
          </div>
        </div>
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
