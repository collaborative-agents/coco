import { useEffect, useState } from 'react';
import { AI_TOOLS } from '../observation-types';

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
  const [aiTools, setAiTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile: any) => {
        setScenario(
          profile?.tutorScenario === 'custom' ? 'custom' : 'everyday_support',
        );
        setAiTools(Array.isArray(profile?.aiTools) ? profile.aiTools : []);
      })
      .catch(() => setStatus('Could not load your preferences.'));
  }, []);
  return (
    <section className="workspace-settings-section">
      <h2>Agent preferences</h2>
      <label>
        Mode{' '}
        <select
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
        >
          <option value="everyday_support">Everyday support</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <fieldset>
        <legend>Your AI tools</legend>
        {Object.entries(AI_TOOLS).map(([id, tool]) => (
          <label key={id} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={aiTools.includes(id)}
              onChange={(event) =>
                setAiTools((current) =>
                  event.target.checked
                    ? [...current, id]
                    : current.filter((item) => item !== id),
                )
              }
            />{' '}
            {tool.label}
          </label>
        ))}
      </fieldset>
      <button
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
              aiTools,
              hideAvatar: profile?.hideAvatar === true,
            };
            const result = (await window.electron?.ipcRenderer.invoke(
              'update-settings',
              next,
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
