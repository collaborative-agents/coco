import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { EmojiPicker } from './SocialEmojiControls';

const COMPOSER_COLLAPSED_MAX_HEIGHT = 120;
const COMPOSER_EXPANDED_MAX_HEIGHT = 320;
const ACCENT = 'var(--coco-color-primary)';
const BORDER = 'var(--coco-color-border)';
const FONT = 'var(--coco-font-family)';

export default function SocialMessageComposer({
  ariaLabel,
  placeholder,
  value,
  sending,
  emojiPickerLabel,
  onChange,
  onSubmit,
}: {
  ariaLabel: string;
  placeholder: string;
  value: string;
  sending: boolean;
  emojiPickerLabel: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    const textArea = textAreaRef.current;
    if (!textArea) return;
    textArea.style.height = 'auto';
    const contentHeight = Math.max(textArea.scrollHeight, 50);
    const needsExpansion = contentHeight > COMPOSER_COLLAPSED_MAX_HEIGHT;
    setCanExpand(needsExpansion);
    if (!needsExpansion && expanded) {
      setExpanded(false);
    }
    const expandedLimit = Math.min(
      COMPOSER_EXPANDED_MAX_HEIGHT,
      Math.max(180, window.innerHeight * 0.4),
    );
    const maxHeight =
      expanded && needsExpansion
        ? expandedLimit
        : COMPOSER_COLLAPSED_MAX_HEIGHT;
    textArea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textArea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [expanded, value]);

  return (
    <form
      style={{ borderTop: `1px solid ${BORDER}`, padding: 10 }}
      onSubmit={onSubmit}
    >
      <div
        style={{
          border: `1px solid ${BORDER}`,
          borderRadius: 'var(--coco-radius-control)',
          background: 'var(--coco-color-surface)',
          overflow: 'visible',
        }}
      >
        {canExpand && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '4px 7px 0',
            }}
          >
            <button
              type="button"
              aria-label={
                expanded ? 'Collapse message editor' : 'Expand message editor'
              }
              aria-expanded={expanded}
              style={{
                border: 'none',
                padding: '0 3px',
                background: 'transparent',
                color: ACCENT,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 'var(--coco-text-control)',
                fontWeight: 700,
              }}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Collapse editor' : 'Expand editor'}
            </button>
          </div>
        )}
        <textarea
          ref={textAreaRef}
          rows={2}
          aria-label={ariaLabel}
          maxLength={4_000}
          placeholder={placeholder}
          value={value}
          style={{
            width: '100%',
            minHeight: 50,
            boxSizing: 'border-box',
            display: 'block',
            resize: 'none',
            border: 'none',
            borderRadius: 'var(--coco-radius-control)',
            padding: '9px 11px 4px',
            background: 'transparent',
            color: 'var(--coco-color-text)',
            fontFamily: FONT,
            fontSize: 'var(--coco-text-body)',
            lineHeight: 'var(--coco-leading-body)',
            outline: 'none',
            transition: 'height 100ms ease',
          }}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 6px 6px',
          }}
        >
          <EmojiPicker
            label={emojiPickerLabel}
            onSelect={(emoji) => onChange(value + emoji)}
          />
          <span style={{ flex: 1 }} />
          <button
            type="submit"
            disabled={!value.trim() || sending}
            style={{
              border: 'none',
              borderRadius: 'var(--coco-radius-control)',
              padding: '6px 10px',
              background: ACCENT,
              color: 'var(--coco-color-surface)',
              cursor: !value.trim() || sending ? 'default' : 'pointer',
              fontFamily: FONT,
              fontSize: 'var(--coco-text-control)',
              fontWeight: 700,
              opacity: !value.trim() || sending ? 0.45 : 1,
            }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </form>
  );
}
