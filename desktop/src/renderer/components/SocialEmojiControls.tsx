import React, { useCallback, useRef, useState } from 'react';
import useDismissiblePopover from './useDismissiblePopover';

export const SOCIAL_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

export type SocialEmoji = (typeof SOCIAL_EMOJIS)[number];

export interface MessageReaction {
  emoji: SocialEmoji;
  count: number;
  reacted_by_me: boolean;
}

const pickerStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 3,
  padding: 4,
  border: '1px solid #e5e7eb',
  borderRadius: 9,
  background: '#fff',
  boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
};

const emojiButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 7,
  padding: 0,
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 17,
};

export function EmojiPicker({
  label,
  onSelect,
}: {
  label: string;
  onSelect: (emoji: SocialEmoji) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissiblePopover(containerRef, open, dismiss);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '0 0 auto' }}>
      {open && (
        <div
          role="group"
          aria-label={label}
          style={{
            ...pickerStyle,
            position: 'absolute',
            zIndex: 5,
            left: 0,
            bottom: 'calc(100% + 5px)',
            width: 100,
          }}
        >
          {SOCIAL_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              style={emojiButtonStyle}
              aria-label={`Insert ${emoji}`}
              onClick={() => {
                onSelect(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        style={{
          ...emojiButtonStyle,
          border: '1px solid #e5e7eb',
          color: '#4b5563',
          fontSize: 15,
        }}
        onClick={() => setOpen((current) => !current)}
      >
        ☺
      </button>
    </div>
  );
}

export function MessageReactionControls({
  messageId,
  reactions,
  showAddButton,
  onToggle,
}: {
  messageId: string;
  reactions: MessageReaction[];
  showAddButton: boolean;
  onToggle: (emoji: SocialEmoji) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissiblePopover(containerRef, open, dismiss);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'static',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 3,
        marginTop: reactions.length ? 4 : 0,
      }}
    >
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-label={`${reaction.reacted_by_me ? 'Remove' : 'Add'} ${reaction.emoji} reaction`}
          aria-pressed={reaction.reacted_by_me}
          style={{
            minWidth: 32,
            height: 23,
            border: reaction.reacted_by_me
              ? '1px solid #93c5fd'
              : '1px solid #e5e7eb',
            borderRadius: 12,
            padding: '0 7px',
            background: reaction.reacted_by_me ? '#eff6ff' : '#fff',
            color: '#374151',
            cursor: 'pointer',
            fontSize: 12,
          }}
          onClick={() => onToggle(reaction.emoji)}
        >
          {reaction.emoji} {reaction.count}
        </button>
      ))}
      <button
        type="button"
        aria-label={`React to message ${messageId}`}
        aria-expanded={open}
        style={{
          position: 'absolute',
          top: -10,
          right: -8,
          width: 23,
          height: 23,
          border: '1px solid #e5e7eb',
          borderRadius: '50%',
          padding: 0,
          background: '#fff',
          color: '#6b7280',
          cursor: 'pointer',
          fontSize: 12,
          opacity: showAddButton || open ? 1 : 0,
          pointerEvents: showAddButton || open ? 'auto' : 'none',
          transition: 'opacity 100ms ease',
        }}
        onClick={() => setOpen((current) => !current)}
      >
        +
      </button>
      {open && (
        <div
          role="group"
          aria-label={`Choose a reaction for message ${messageId}`}
          style={{
            ...pickerStyle,
            position: 'absolute',
            zIndex: 5,
            top: 18,
            right: -8,
            flexWrap: 'nowrap',
          }}
        >
          {SOCIAL_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              style={emojiButtonStyle}
              aria-label={`React with ${emoji}`}
              onClick={() => {
                onToggle(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function optimisticallyToggleReaction(
  reactions: MessageReaction[],
  emoji: SocialEmoji,
): MessageReaction[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing) {
    return [...reactions, { emoji, count: 1, reacted_by_me: true }];
  }

  const nextCount = existing.count + (existing.reacted_by_me ? -1 : 1);
  if (nextCount === 0) {
    return reactions.filter((reaction) => reaction.emoji !== emoji);
  }
  return reactions.map((reaction) =>
    reaction.emoji === emoji
      ? {
          ...reaction,
          count: nextCount,
          reacted_by_me: !reaction.reacted_by_me,
        }
      : reaction,
  );
}
