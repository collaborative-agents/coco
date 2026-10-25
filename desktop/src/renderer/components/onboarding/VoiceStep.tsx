import { useEffect, useState } from 'react';

export default function VoiceStep({
  onBusy,
}: {
  onBusy: (busy: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'get-wake-word-settings',
        )) as { enabled?: boolean };
        if (typeof result?.enabled !== 'boolean')
          throw new Error('Unavailable');
        setEnabled(result.enabled);
      } catch {
        setError(
          'Could not load voice activation. You can configure it later in Settings.',
        );
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const toggle = async () => {
    setSaving(true);
    onBusy(true);
    setError('');
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'set-wake-word-settings',
        { enabled: !enabled },
      )) as { success?: boolean; error?: string };
      if (!result?.success)
        throw new Error(result?.error || 'Could not update voice activation.');
      setEnabled(!enabled);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not update voice activation.',
      );
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };

  return (
    <>
      <div className="coco-setup-panel">
        <div className="ob-setting-row">
          <span className="ob-setting-icon" aria-hidden="true">
            ◉
          </span>
          <div className="ob-setting-copy">
            <h2 id="ob-voice-label">Listen for Coco</h2>
            <p id="ob-voice-description">
              Say “Hey Coco” to open chat and start a voice message.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby="ob-voice-label"
            aria-describedby="ob-voice-description"
            className="ob-switch"
            disabled={loading || saving}
            onClick={toggle}
          >
            <span />
          </button>
        </div>
        <div className="ob-voice-detail">
          <h3>It starts with your voice</h3>
          <p>
            Wake phrases are detected on your device. After activation, your
            recorded voice message is sent to the configured model when
            submitted.
          </p>
          <p>
            Enabling this option may ask for microphone access. You can always
            type in chat instead.
          </p>
        </div>
      </div>
      <p className="coco-setup-note">
        Optional. Change voice activation at any time in Settings.
      </p>
      {saving && (
        <p className="coco-setup-note" role="status">
          Updating voice activation…
        </p>
      )}
      {error && (
        <div className="coco-setup-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
