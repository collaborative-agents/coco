import SettingsToggle from './SettingsToggle';
import useScreenHistorySettings from '../../services/screen-history-settings';

export default function ScreenHistorySettings() {
  const history = useScreenHistorySettings();
  return (
    <section
      className="workspace-settings-section"
      aria-labelledby="screen-history-heading"
    >
      <h2 id="screen-history-heading" className="settings-heading">
        Screenshot history
      </h2>
      <SettingsToggle
        id="screen-history-enabled"
        title="Save searchable screenshot history"
        description="Keep screenshots and embeddings locally so Coco can recall details from past screens. Indexing continues while Coco sleeps. Turning this off stops new indexing and screenshot searches; saved history stays on this device."
        checked={history.enabled === true}
        disabled={history.enabled === null || history.saving}
        onChange={(enabled) => void history.update(enabled)}
      />
      {history.saving && (
        <p role="status" className="settings-note">
          Applying…
        </p>
      )}
      {history.error && (
        <p role="alert" className="settings-error">
          {history.error}
        </p>
      )}
    </section>
  );
}
