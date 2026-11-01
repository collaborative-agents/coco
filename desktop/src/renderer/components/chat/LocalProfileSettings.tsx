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
  const [customObserverPrompt, setCustomObserverPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile: any) => {
        setCustomObserverPrompt(
          typeof profile?.customSystemPrompt === 'string'
            ? profile.customSystemPrompt
            : '',
        );
        setScenario(
          profile?.tutorScenario === 'custom' ? 'custom' : 'everyday_support',
        );
      })
      .catch(() => setStatus('Could not load your preferences.'))
      .finally(() => setLoading(false));
  }, []);
  return (
    <section className="workspace-settings-section local-settings">
      <h2>Agent preferences</h2>
      <label className="coco-field">
        Mode{' '}
        <span className="coco-select-wrap">
          <select
            className="coco-select"
            disabled={loading || saving}
            value={scenario}
            onChange={(event) => {
              setScenario(event.target.value);
              setStatus('');
            }}
          >
            <option value="everyday_support">Everyday support</option>
            <option value="custom">Custom</option>
          </select>
        </span>
      </label>
      {scenario === 'custom' && (
        <div className="coco-field">
          <label htmlFor="custom-observer-prompt">Observer agent prompt</label>
          <textarea
            id="custom-observer-prompt"
            className="settings-observer-prompt"
            rows={10}
            maxLength={40000}
            value={customObserverPrompt}
            disabled={loading || saving}
            aria-describedby="custom-observer-prompt-help"
            placeholder="Describe what Coco should look for on your screen."
            onChange={(event) => {
              setCustomObserverPrompt(event.target.value);
              setStatus('');
            }}
          />
          <span id="custom-observer-prompt-help" className="settings-note">
            Customize what the observer looks for. The required observation
            report fields are always included so Coco can use its output.
          </span>
          <details className="settings-note">
            <summary>Required report fields</summary>
            <p>
              observation, user_intent, inefficiency_patterns,
              mistake_made_by_human, task_complete, applying_ai_output, status
            </p>
            <p>
              Coco adds the JSON reporting format automatically. These fields
              cannot be removed by editing the prompt.
            </p>
          </details>
        </div>
      )}
      <button
        className="coco-button coco-button--primary"
        type="button"
        disabled={
          loading ||
          saving ||
          (scenario === 'custom' && !customObserverPrompt.trim())
        }
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
              {
                scenario: next.scenario,
                hideAvatar: next.hideAvatar,
                customObserverPrompt,
              },
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
