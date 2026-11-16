import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  THINKING_LABELS,
  type ModelThinking,
} from '../../../shared/model-thinking';
import './ThinkingPicker.css';

export default function ThinkingPicker({
  modelLabel,
  modelSelector,
  value,
  levels,
  defaultLevel,
  disabled,
  onChange,
}: {
  modelLabel: string;
  modelSelector: ReactNode;
  value: ModelThinking;
  levels: ModelThinking[];
  defaultLevel: ModelThinking;
  disabled: boolean;
  onChange: (value: ModelThinking) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const selected = levels.includes(value) ? value : defaultLevel;
  const index = Math.max(0, levels.indexOf(selected));
  const levelKey = levels.join(',');
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    slider.current?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    setOpen(false);
  }, [disabled, levelKey, modelLabel]);
  return (
    <div className="thinking-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="thinking-picker__trigger"
        aria-label={`${modelLabel}, thinking: ${THINKING_LABELS[selected]}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="thinking-picker__model">{modelLabel}</span>
        <span className="thinking-picker__amount">
          {THINKING_LABELS[selected]}
        </span>
      </button>
      {open && (
        <div
          className="thinking-picker__panel"
          role="dialog"
          aria-label="Model and thinking"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
          onBlur={(event) => {
            if (
              event.relatedTarget &&
              !root.current?.contains(event.relatedTarget as Node)
            )
              setOpen(false);
          }}
        >
          <div className="thinking-picker__heading">
            {modelSelector}
            <span className="thinking-picker__amount" aria-live="polite">
              {THINKING_LABELS[selected]}
            </span>
          </div>
          <div
            className="thinking-picker__slider"
            style={
              {
                '--thinking-fill': `${levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0}%`,
              } as CSSProperties
            }
          >
            <div className="thinking-picker__track" aria-hidden="true" />
            <div className="thinking-picker__stops" aria-hidden="true">
              {levels.map((level) => (
                <span key={level} />
              ))}
            </div>
            <input
              ref={slider}
              type="range"
              aria-label="Thinking amount"
              aria-valuetext={THINKING_LABELS[selected]}
              min={0}
              max={levels.length - 1}
              step={1}
              value={index}
              disabled={disabled}
              onChange={(event) => onChange(levels[Number(event.target.value)])}
            />
          </div>
        </div>
      )}
    </div>
  );
}
