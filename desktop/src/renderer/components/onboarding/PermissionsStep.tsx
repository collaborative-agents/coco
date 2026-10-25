import { useCallback, useEffect, useState } from 'react';

type PermissionTarget = 'screen-recording' | 'accessibility';
interface PermissionHealth {
  missing: { target: string }[];
}
const PERMISSIONS: {
  target: PermissionTarget;
  title: string;
  description: string;
  symbol: string;
}[] = [
  {
    target: 'screen-recording',
    title: 'Screen Recording',
    symbol: '▣',
    description:
      'Let Coco see your screen to understand your task and offer relevant help.',
  },
  {
    target: 'accessibility',
    title: 'Accessibility',
    symbol: '⌘',
    description:
      'Let Coco detect keyboard and mouse activity to recognize when your task changes.',
  },
];

export default function PermissionsStep({
  onReady,
}: {
  onReady: (ready: boolean) => void;
}) {
  const [health, setHealth] = useState<PermissionHealth | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const isMac = /Mac/i.test(navigator.platform);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'get-system-permissions',
      )) as PermissionHealth;
      if (!Array.isArray(result?.missing))
        throw new Error('Permission status unavailable.');
      setHealth(result);
      onReady(result.missing.length === 0);
      setError('');
    } catch {
      onReady(false);
      setError('Could not check permissions. Please try again.');
    }
  }, [onReady]);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 3000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const grant = async (target: PermissionTarget) => {
    setOpening(target);
    setError('');
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'open-system-permissions',
        target,
      )) as { success?: boolean; error?: string };
      if (!result?.success)
        throw new Error(result?.error || 'Could not open System Settings.');
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not open System Settings.',
      );
    } finally {
      setOpening(null);
    }
  };

  return (
    <>
      <div className="coco-setup-panel">
        {PERMISSIONS.map(({ target, title, description, symbol }) => {
          const granted =
            health !== null &&
            !health.missing.some((item) => item.target === target);
          return (
            <div className="ob-setting-row" key={target}>
              <span className="ob-setting-icon" aria-hidden="true">
                {symbol}
              </span>
              <div className="ob-setting-copy">
                <h2>{title}</h2>
                <p>{description}</p>
              </div>
              <div className="ob-permission-action">
                {granted ? (
                  <span className="ob-granted">
                    {isMac ? 'Granted' : 'Available'} ✓
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ob-btn ob-btn-secondary"
                      disabled={!health || opening !== null}
                      onClick={() => grant(target)}
                    >
                      {opening === target ? 'Opening…' : 'Grant access'}
                    </button>
                    <span className="ob-permission-status">
                      {health ? 'Permission required' : 'Checking…'}
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <details className="ob-privacy" open>
        <summary>Privacy &amp; your data</summary>
        <p>
          Screen images and context are sent to your configured AI models to provide assistance.{' '}
          Rolling screenshots are deleted locally after processing.
        </p>
        <p>
          Raw keyboard and mouse activity is processed locally and is not sent
          to a model.
        </p>
        <p>
          You can pause observation by choosing{' '}
          <strong>Put Coco to Sleep</strong> from the menu-bar icon. Hiding the
          avatar does not pause observation.
        </p>
      </details>
      {error && (
        <div className="coco-setup-error" role="alert">
          {error}{' '}
          <button type="button" className="ob-text-button" onClick={refresh}>
            Check again
          </button>
        </div>
      )}
    </>
  );
}
