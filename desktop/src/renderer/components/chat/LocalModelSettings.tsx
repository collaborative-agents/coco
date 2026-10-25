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
        Choose your sensing and agent models. Saving restarts the local
        services.
      </p>
      <ModelsStep {...models.modelProps} />
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
      {saved && <span role="status"> Saved</span>}
    </section>
  );
}
