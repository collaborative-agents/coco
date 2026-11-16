import './Settings.css';
import { useState } from 'react';
import ModelsStep from '../onboarding/ModelsStep';
import useModelSetup from '../onboarding/useModelSetup';

/** Model credentials stay in the desktop's existing local configuration store. */
export default function LocalModelSettings() {
  const models = useModelSetup();
  const [saved, setSaved] = useState(false);
  return (
    <section className="workspace-settings-section local-settings">
      <h2>Models &amp; providers</h2>
      <p>
        Connect models for Coco chat through Pi or add another model service.
        Screen sensing is optional.
      </p>
      {models.hasUnsavedChanges && (
        <p className="model-settings-reminder">
          You have pending changes. Save your model settings below to apply them.
        </p>
      )}
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
