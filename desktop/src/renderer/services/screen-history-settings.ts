import { useCallback, useEffect, useRef, useState } from 'react';

interface SettingsResult {
  success: boolean;
  enabled?: boolean;
  error?: string;
}

export default function useScreenHistorySettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let changed = false;
    const apply = (value: unknown) => {
      const result = value as SettingsResult | undefined;
      if (!mounted.current) return;
      if (result?.success && typeof result.enabled === 'boolean') {
        setEnabled(result.enabled);
        setError('');
      } else
        setError(
          result?.error || 'Screenshot history settings are unavailable.',
        );
    };
    const remove = window.electron?.ipcRenderer.on?.(
      'screen-history-settings-changed',
      (value) => {
        changed = true;
        apply(value);
      },
    );
    window.electron?.ipcRenderer
      .invoke('get-screen-history-settings')
      .then((value) => {
        if (!changed) apply(value);
      })
      .catch(() => apply(undefined));
    return () => {
      mounted.current = false;
      remove?.();
    };
  }, []);
  const update = useCallback(
    async (value: boolean) => {
      if (saving) return;
      setSaving(true);
      setError('');
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'set-screen-history-enabled',
          { enabled: value },
        )) as SettingsResult;
        if (!result?.success || typeof result.enabled !== 'boolean')
          throw new Error(
            result?.error || 'Screenshot history could not be changed.',
          );
        if (mounted.current) setEnabled(result.enabled);
      } catch (err) {
        if (mounted.current) setError((err as Error).message);
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [saving],
  );
  return { enabled, saving, error, update };
}
