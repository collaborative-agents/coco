import { useEffect, useState } from 'react';

const STRUGGLE_OPTIONS = [
  { value: 30,   label: '30 sec' },
  { value: 45,   label: '45 sec' },
  { value: 60,   label: '1 min' },
  { value: 120,  label: '2 min' },
  { value: 180,  label: '3 min' },
  { value: 300,  label: '5 min' },
  { value: 600,  label: '10 min' },
  { value: -1,   label: 'Custom...' },
];

export default function SessionSetupView() {
  const [taskLabel, setTaskLabel] = useState<string>('');
  const [struggleSeconds, setStruggleSeconds] = useState(120);
  const [customSeconds, setCustomSeconds] = useState<string>('');

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'session-setup-init',
      (data: any) => {
        if (data?.taskLabel) setTaskLabel(String(data.taskLabel));
      },
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  const isCustom = struggleSeconds === -1;
  const effectiveSeconds = isCustom
    ? Math.max(10, parseInt(customSeconds, 10) || 120)
    : struggleSeconds;

  const handleConfirm = () => {
    // Model selection is disabled in tutor mode for now — the tutor server uses
    // the model configured via its --model_name startup flag. We intentionally
    // omit `model` so the backend doesn't override that.
    window.electron?.ipcRenderer.sendMessage('proactive-session-confirmed', {
      struggleSeconds: effectiveSeconds,
      taskLabel: taskLabel.trim() || undefined,
    });
    window.close();
  };

  const handleCancel = () => {
    window.close();
  };

  return (
    <div className="setup-root">
      <div className="setup-card">
        {/* Header */}
        <div className="setup-header">
          <span className="setup-brand-dot" />
          <span className="setup-brand-name">Start AI Coaching Session</span>
        </div>

        {/* Task label — editable so the user can refine the detected description */}
        <div className="setup-field">
          <label className="setup-label" htmlFor="setup-task">Task detected</label>
          <textarea
            id="setup-task"
            className="setup-task-textarea"
            value={taskLabel}
            onChange={(e) => setTaskLabel(e.target.value)}
            placeholder="Describe what you're working on…"
            rows={3}
          />
        </div>

        {/* Struggle detection interval */}
        <div className="setup-field">
          <div className="setup-label-row">
            <label className="setup-label" htmlFor="setup-struggle">Check in on me every</label>
            <span className="setup-help-wrap">
              <button type="button" className="setup-help-btn" tabIndex={-1} aria-label="Help">?</button>
              <span role="tooltip" className="setup-help-tooltip">
                Controls how often the AI checks your screen and offers help.
                Shorter = more check-ins; longer = fewer interruptions.
                <span className="setup-help-arrow" />
              </span>
            </span>
          </div>
          <select
            id="setup-struggle"
            className="setup-select"
            value={struggleSeconds}
            onChange={(e) => setStruggleSeconds(Number(e.target.value))}
          >
            {STRUGGLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {isCustom && (
            <input
              type="number"
              min={10}
              placeholder="seconds"
              className="setup-custom-input"
              value={customSeconds}
              onChange={(e) => setCustomSeconds(e.target.value)}
            />
          )}
        </div>

        {/* Actions */}
        <div className="setup-actions">
          <button type="button" className="setup-btn-cancel" onClick={handleCancel}>
            Cancel
          </button>
          <button type="button" className="setup-btn-confirm" onClick={handleConfirm}>
            Start session →
          </button>
        </div>
      </div>
    </div>
  );
}
