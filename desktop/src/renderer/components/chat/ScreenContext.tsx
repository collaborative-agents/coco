import { useState } from 'react';
import './ScreenContext.css';

const SUMMARY_CHARS = 90;

/** The observation's first sentence, short enough for one line. */
export function screenContextSummary(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return first.length > SUMMARY_CHARS
    ? `${first.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
    : first;
}

function ScreenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </svg>
  );
}

/**
 * Screen context waiting to go out with the next message, above the composer.
 * It can be read in full or removed before sending.
 */
export function ScreenContextChip({
  text,
  onRemove,
}: {
  text: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="screen-context screen-context--pending">
      <div className="screen-context__row">
        <button
          type="button"
          className="screen-context__toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ScreenIcon />
          <span className="screen-context__label">Screen context</span>
          <span className="screen-context__summary">
            {screenContextSummary(text)}
          </span>
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        <button
          type="button"
          className="screen-context__remove"
          aria-label="Remove screen context"
          title="Don't send screen context"
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {open && <div className="screen-context__text">{text}</div>}
    </div>
  );
}

/** Screen context that went out with a sent message, under the user's bubble. */
export function ScreenContextTag({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="screen-context screen-context--sent">
      <button
        type="button"
        className="screen-context__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ScreenIcon />
        <span className="screen-context__label">Screen context</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="screen-context__text">{text}</div>}
    </div>
  );
}
