import { useEffect, useRef, useState } from 'react';
import { WakeWordListener } from '../wake-word-listener';

/**
 * Owns continuous microphone capture independently of Coco's visible UI.
 *
 * Main keeps this renderer shown as a transparent, non-interactive 1 px
 * window. A genuinely hidden BrowserWindow can leave getUserMedia suspended
 * on macOS, which is why capture must not live in either the chat or pet view.
 */
export default function WakeWordCaptureView() {
  const [windowReady, setWindowReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [restartToken, setRestartToken] = useState(0);
  const listenerRef = useRef(new WakeWordListener());
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const applySettings = (value: unknown) => {
      const settings = value as
        | {
            enabled?: unknown;
            capturePaused?: unknown;
          }
        | undefined;
      if (typeof settings?.enabled === 'boolean') setEnabled(settings.enabled);
      if (typeof settings?.capturePaused === 'boolean') {
        setPaused(settings.capturePaused);
      }
    };
    window.electron?.ipcRenderer
      .invoke('get-wake-word-settings')
      .then(applySettings)
      .catch((error: unknown) => {
        window.electron?.ipcRenderer.sendMessage('wake-word-capture-status', {
          state: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    const removeSettings = window.electron?.ipcRenderer.on(
      'wake-word-settings-changed',
      applySettings,
    );
    const removePause = window.electron?.ipcRenderer.on(
      'wake-word-capture-paused-changed',
      (value: unknown) => {
        const state = value as { paused?: unknown } | undefined;
        if (typeof state?.paused === 'boolean') setPaused(state.paused);
      },
    );
    const removeWindowReady = window.electron?.ipcRenderer.on(
      'wake-word-capture-window-ready',
      () => setWindowReady(true),
    );
    window.electron?.ipcRenderer.sendMessage(
      'wake-word-capture-renderer-ready',
    );
    return () => {
      if (typeof removeSettings === 'function') removeSettings();
      if (typeof removePause === 'function') removePause();
      if (typeof removeWindowReady === 'function') removeWindowReady();
    };
  }, []);

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-coco-sleep-mode')
      .then((value: unknown) => {
        const state = value as { sleeping?: unknown } | undefined;
        setSleeping(state?.sleeping === true);
        return undefined;
      })
      .catch(() => undefined);
    const removeSleep = window.electron?.ipcRenderer.on(
      'coco-sleep-mode-changed',
      (value: unknown) => {
        const state = value as { sleeping?: unknown } | undefined;
        setSleeping(state?.sleeping === true);
      },
    );
    return () => {
      if (typeof removeSleep === 'function') removeSleep();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const listener = listenerRef.current;
    const shouldListen = windowReady && enabled && !paused && !sleeping;
    if (!shouldListen) {
      listener
        .stop()
        .then(() => {
          if (!cancelled) {
            window.electron?.ipcRenderer.sendMessage(
              'wake-word-capture-status',
              {
                state: paused ? 'paused' : 'stopped',
              },
            );
          }
          return undefined;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }

    window.electron?.ipcRenderer.sendMessage('wake-word-capture-status', {
      state: 'starting',
    });
    listener
      .start(
        (frame) => {
          window.electron?.ipcRenderer.sendMessage(
            'wake-word-audio-frame',
            frame,
          );
        },
        (reason) => {
          if (cancelled || restartTimerRef.current) return;
          window.electron?.ipcRenderer.sendMessage('wake-word-capture-status', {
            state: 'restarting',
            detail: reason,
          });
          restartTimerRef.current = setTimeout(() => {
            restartTimerRef.current = null;
            setRestartToken((value) => value + 1);
          }, 1_000);
        },
      )
      .then(() => {
        if (!cancelled) {
          window.electron?.ipcRenderer.sendMessage('wake-word-capture-status', {
            state: 'active',
          });
        }
        return undefined;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          window.electron?.ipcRenderer.sendMessage('wake-word-capture-status', {
            state: 'error',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      listener.stop().catch(() => undefined);
    };
  }, [enabled, paused, restartToken, sleeping, windowReady]);

  return null;
}
