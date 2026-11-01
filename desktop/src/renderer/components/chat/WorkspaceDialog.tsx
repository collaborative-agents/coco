/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
import { useEffect, useId, useRef, type ReactNode } from 'react';

export default function WorkspaceDialog({
  open,
  title,
  children,
  onClose,
  busy = false,
  headerAction = null,
  className = '',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  headerAction?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    panel.focus();
    const handleKey = (event: KeyboardEvent) => {
      // Nested dialogs own their keyboard interactions.
      if (panel.querySelector('[aria-modal="true"]')) return;
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, iframe, [tabindex="0"]',
        ),
      ).filter(
        (el) => !el.closest('[hidden]') && el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', handleKey);
    return () => {
      panel.removeEventListener('keydown', handleKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <div className="workspace-dialog-backdrop" hidden={!open}>
      <div
        className={`workspace-dialog ${className}`}
        ref={ref}
        role="dialog"
        aria-modal={open || undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="workspace-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <div className="workspace-dialog-actions">
            {headerAction}
            <button
              className="workspace-dialog-close"
              type="button"
              aria-label="Close dialog"
              title="Close"
              disabled={busy}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        <div className="workspace-dialog-content">{children}</div>
      </div>
    </div>
  );
}
