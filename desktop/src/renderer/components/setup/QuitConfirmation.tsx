import { useEffect, useRef } from 'react';

export default function QuitConfirmation({
  onCancel,
}: {
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const buttons = dialogRef.current?.querySelectorAll('button');
    buttons?.[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Tab' && buttons?.length) {
        event.preventDefault();
        const next =
          document.activeElement === buttons[0] ? buttons[1] : buttons[0];
        next.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onCancel]);

  return (
    <div
      ref={dialogRef}
      className="auth-quit-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="auth-quit-title"
      aria-describedby="auth-quit-detail"
    >
      <div className="auth-quit-dialog">
        <h2 id="auth-quit-title">Quit Coco Learn?</h2>
        <p id="auth-quit-detail">
          Are you sure you want to quit? You will need to reopen the app to
          continue.
        </p>
        <div className="auth-quit-actions">
          <button
            type="button"
            className="auth-quit-cancel"
            onClick={() => onCancel()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="auth-quit-confirm"
            onClick={() =>
              window.electron.ipcRenderer.sendMessage('quit-from-onboarding')
            }
          >
            Quit Coco Learn
          </button>
        </div>
      </div>
    </div>
  );
}
