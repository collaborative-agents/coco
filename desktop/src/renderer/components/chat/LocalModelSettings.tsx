import './Settings.css';
import { useEffect, useState } from 'react';
import ModelsStep from '../onboarding/ModelsStep';
import useModelSetup from '../onboarding/useModelSetup';

/** Model credentials stay in the desktop's existing local configuration store. */
export default function LocalModelSettings({
  onUnsavedChanges,
}: {
  onUnsavedChanges?: (pending: boolean) => void;
}) {
  const models = useModelSetup();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    onUnsavedChanges?.(models.hasUnsavedChanges);
  }, [models.hasUnsavedChanges, onUnsavedChanges]);
  useEffect(() => () => onUnsavedChanges?.(false), [onUnsavedChanges]);
  return (
    <section className="workspace-settings-section local-settings">
      <h2>Models &amp; providers</h2>
      <p>
        Choose a provider and model for Coco chat. Sign in, use an API key, or
        connect a local model. Screen understanding is optional.
      </p>
      <ModelsStep {...models.modelProps} />
      <div className="model-settings-save-bar">
        <button
          className="coco-button coco-button--primary"
          type="button"
          disabled={models.savingModels}
          onClick={async () => {
            setSaved(false);
            setSaved(await models.saveModels());
          }}
        >
          {models.savingModels ? 'Saving…' : 'Save model settings'}
        </button>
        <span role="status" className="model-settings-save-status">
          {models.savingModels
            ? 'Saving changes…'
            : models.hasUnsavedChanges
              ? 'Unsaved changes — save to apply.'
              : saved
                ? 'Saved'
                : ''}
        </span>
      </div>
    </section>
  );
}
