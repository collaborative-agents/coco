import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import './ActionTooltip.css';

export default function ActionTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
    setPosition(null);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return undefined;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = tip.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(
          anchor.left + (anchor.width - bounds.width) / 2,
          window.innerWidth - bounds.width - 8,
        ),
      ),
      top:
        anchor.top >= bounds.height + 16
          ? anchor.top - bounds.height - 8
          : anchor.bottom + 8,
    });
  }, [open, label]);
  return (
    <span
      ref={trigger}
      className="composer-tooltip-trigger"
      onMouseEnter={() => {
        timer.current = setTimeout(() => setOpen(true), 250);
      }}
      onMouseLeave={close}
      onFocusCapture={(event) => {
        if (event.target.matches(':focus-visible')) setOpen(true);
      }}
      onBlurCapture={close}
      onPointerDownCapture={close}
      onClickCapture={close}
    >
      {cloneElement(children, {
        'aria-describedby': open ? id : children.props['aria-describedby'],
      })}
      {open &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            className="composer-action-tooltip"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
