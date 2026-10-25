import type React from 'react';
import { S } from './styles';
import type { SavedConversation, ChatMessage } from './types';
import { TutorMessage, SuggestionMessage } from './MessageContent';
import AgentActivityList from './AgentActivityList';
import ChatMetrics from './ChatMetrics';
import { ScreenContextTag } from './ScreenContext';
import RatingButtons from '../RatingButtons';
import { messageCopyKey } from './message-format';
import { chatSuggestionText } from '../../../shared/chat-suggestion';
import {
  SCREEN_TASK_PROMPT,
  SECONDARY_CHAT_PROMPTS,
  SUGGESTION_FOLLOW_UPS,
} from './constants';

interface Props {
  reviewing: SavedConversation | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  visibleMessages: ChatMessage[];
  sending: boolean;
  profile: { scenario: string; aiTools: string[]; hideAvatar: boolean };
  startingNewSession: boolean;
  sendMessage: (
    text: string,
    images: string[],
    hotkeyImages?: string[],
    requestKind?: 'chat' | 'practice_suggestions',
  ) => Promise<void>;
  openImagePreview: (imageDataUrl: string) => void;
  copiedMessageKey: string | null;
  copyMessage: (message: ChatMessage, key: string) => Promise<void>;
  toggleSuggestionFold: (target: ChatMessage) => void;
  retryMessage: (message: ChatMessage) => Promise<void>;
  ratings: Record<string, 'up' | 'down'>;
  rateMessage: (m: ChatMessage, dir: 'up' | 'down') => void;
  hasRunningTool: boolean;
}

export default function ChatTranscript({
  reviewing,
  listRef,
  visibleMessages,
  sending,
  profile,
  startingNewSession,
  sendMessage,
  openImagePreview,
  copiedMessageKey,
  copyMessage,
  toggleSuggestionFold,
  retryMessage,
  ratings,
  rateMessage,
  hasRunningTool,
}: Props) {
  return (
    <div style={S.list} ref={listRef}>
      {visibleMessages.length === 0 &&
        !sending &&
        (profile.scenario === 'ai_upskilling' && !reviewing ? (
          <div style={S.starterPanel}>
            <div style={S.starterTitle}>How can Coco help?</div>
            <button
              type="button"
              style={{
                ...S.screenTaskBtn,
                ...(sending || startingNewSession ? S.sendBtnDisabled : {}),
              }}
              disabled={sending || startingNewSession}
              onClick={() => sendMessage(SCREEN_TASK_PROMPT, [])}
            >
              {SCREEN_TASK_PROMPT}
            </button>
            {SECONDARY_CHAT_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                style={{
                  ...S.secondaryPromptBtn,
                  ...(startingNewSession ? S.sendBtnDisabled : {}),
                }}
                disabled={startingNewSession}
                onClick={() => sendMessage(prompt, [])}
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : (
          <div style={S.empty}>
            Ask Coco about your task, an AI tool, or anything else.
            <br />
            You can paste a screenshot to show what you&apos;re working on.
          </div>
        ))}
      {visibleMessages.map((m, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div
          key={i}
          data-request-id={m.requestId}
          style={m.role === 'user' ? S.userRow : S.tutorRow}
        >
          {m.role === 'user' ? (
            <>
              <div style={S.userBubble}>
                {m.text}
                {m.images && m.images.length > 0 && (
                  <div style={S.thumbRow}>
                    {m.images.map((src, j) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <button
                        key={j}
                        type="button"
                        style={S.imagePreviewButton}
                        aria-label={`Preview message attachment ${j + 1}`}
                        title="Preview attachment"
                        onClick={() => openImagePreview(src)}
                      >
                        <img
                          src={src}
                          alt={`Attachment ${j + 1}`}
                          style={S.thumb}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {m.screenContext && <ScreenContextTag text={m.screenContext} />}
              {m.text.trim() && (
                <div style={S.userMessageActions}>
                  <button
                    type="button"
                    style={{
                      ...S.copyMessageBtn,
                      ...(copiedMessageKey === messageCopyKey(m, i)
                        ? S.copyMessageBtnDone
                        : {}),
                    }}
                    aria-label="Copy user message"
                    title="Copy message"
                    onClick={() => void copyMessage(m, messageCopyKey(m, i))}
                  >
                    {copiedMessageKey === messageCopyKey(m, i)
                      ? 'Copied ✓'
                      : 'Copy'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={S.tutorAvatar}>C</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                {(m.activity && m.activity.length > 0) ||
                (!m.activity && m.toolCalls?.length) ? (
                  <AgentActivityList
                    requestId={m.requestId}
                    activity={
                      m.activity ??
                      m.toolCalls?.map((call) => ({
                        kind: 'tool' as const,
                        call,
                      })) ??
                      []
                    }
                    interactive={
                      !reviewing && sending && i === visibleMessages.length - 1
                    }
                  />
                ) : null}
                {m.suggestion && (
                  <SuggestionMessage
                    suggestion={m.suggestion}
                    folded={m.folded === true}
                    onToggleFold={() => toggleSuggestionFold(m)}
                    onRun={
                      reviewing
                        ? undefined
                        : () =>
                            void sendMessage(
                              `Carry out this suggestion for me:\n\n${chatSuggestionText(m.suggestion!)}`,
                              [],
                            )
                    }
                    runDisabled={sending || startingNewSession}
                  />
                )}
                {m.suggestion &&
                  !m.folded &&
                  !reviewing &&
                  !sending &&
                  i === visibleMessages.length - 1 && (
                    <div style={S.followUpRow} aria-label="Follow-up questions">
                      {SUGGESTION_FOLLOW_UPS.map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          style={{
                            ...S.followUpBtn,
                            ...(startingNewSession ? S.sendBtnDisabled : {}),
                          }}
                          disabled={startingNewSession}
                          onClick={() => void sendMessage(prompt, [])}
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  )}
                {!m.suggestion && (m.text || m.isError) && (
                  <div style={m.isError ? S.errBubble : S.tutorBubble}>
                    {m.isError ? (
                      <>
                        <div>{m.text}</div>
                        {m.retryText !== undefined && (
                          <button
                            type="button"
                            style={{
                              ...S.retryBtn,
                              ...(sending || startingNewSession
                                ? S.sendBtnDisabled
                                : {}),
                            }}
                            disabled={sending || startingNewSession}
                            onClick={() => retryMessage(m)}
                          >
                            Retry
                          </button>
                        )}
                      </>
                    ) : (
                      <TutorMessage text={m.text} />
                    )}
                  </div>
                )}
                {m.stopped && (
                  <div style={S.typing}>
                    Run stopped · completed changes remain
                  </div>
                )}
                {!m.isError && (
                  <ChatMetrics
                    observerMetrics={m.observerMetrics}
                    tutorMetrics={m.tutorMetrics}
                  />
                )}
                {(m.text.trim() || (!m.isError && m.id)) && (
                  <div style={S.feedbackRow}>
                    {m.text.trim() && (
                      <button
                        type="button"
                        style={{
                          ...S.copyMessageBtn,
                          ...(copiedMessageKey === messageCopyKey(m, i)
                            ? S.copyMessageBtnDone
                            : {}),
                        }}
                        aria-label="Copy tutor message"
                        title="Copy message"
                        onClick={() =>
                          void copyMessage(m, messageCopyKey(m, i))
                        }
                      >
                        {copiedMessageKey === messageCopyKey(m, i)
                          ? 'Copied ✓'
                          : 'Copy'}
                      </button>
                    )}
                    {!m.isError && m.id && (
                      <RatingButtons
                        value={ratings[m.id]}
                        onRate={(dir) => rateMessage(m, dir)}
                        className="coco-rating--compact"
                      />
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ))}
      {sending && !hasRunningTool && (
        <div style={S.typing}>Coco is thinking…</div>
      )}
    </div>
  );
}
