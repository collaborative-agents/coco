import './Settings.css';
import { useEffect, useState } from 'react';

export default function LocalProfileSettings({
  onSaved,
}: {
  onSaved: (profile: {
    scenario: string;
    aiTools: string[];
    hideAvatar: boolean;
  }) => void;
}) {
  const [scenario, setScenario] = useState('everyday_support');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile: any) => {
        setScenario(
          profile?.tutorScenario === 'custom' ? 'custom' : 'everyday_support',
        );
      })
      .catch(() => setStatus('Could not load your preferences.'));
  }, []);
  return (
    <section className="workspace-settings-section local-settings">
      <h2>Agent preferences</h2>
      <label className="coco-field">
        Mode{' '}
        <span className="coco-select-wrap">
          <select
            className="coco-select"
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
          >
            <option value="everyday_support">Everyday support</option>
            <option value="custom">Custom</option>
          </select>
        </span>
      </label>
      <button
        className="coco-button coco-button--primary"
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setStatus('');
          try {
            const profile = (await window.electron?.ipcRenderer.invoke(
              'get-profile',
            )) as { hideAvatar?: boolean };
            const next = {
              scenario,
              aiTools: [] as string[],
              hideAvatar: profile?.hideAvatar === true,
            };
            const result = (await window.electron?.ipcRenderer.invoke(
              'update-settings',
              { scenario: next.scenario, hideAvatar: next.hideAvatar },
            )) as { success?: boolean; error?: string };
            if (!result?.success)
              throw new Error(result?.error ?? 'Could not save preferences.');
            onSaved(next);
            setStatus('Saved');
          } catch (error) {
            setStatus(String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : 'Save preferences'}
      </button>
      {status && <span role="status"> {status}</span>}
    </section>
  );
}
