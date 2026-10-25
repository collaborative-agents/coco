import type { ComponentProps } from 'react';
import VoiceSettings from './VoiceSettings';
import SettingsToggle from './SettingsToggle';
import './Settings.css';

type Props = ComponentProps<typeof VoiceSettings> & {
  editHideAvatar: boolean;
  avatarSaving: boolean;
  updateAvatarVisibility: (hidden: boolean) => Promise<void>;
  avatarSaveError: string;
};

export default function PreferencesSettings({
  editHideAvatar,
  avatarSaving,
  updateAvatarVisibility,
  avatarSaveError,
  ...voice
}: Props) {
  return (
    <section
      className="workspace-settings-section"
      aria-labelledby="preferences-heading"
    >
      <h2 id="preferences-heading" className="settings-heading">
        Voice &amp; desktop avatar
      </h2>
      <VoiceSettings
        wakeWordEnabled={voice.wakeWordEnabled}
        wakeWordSaving={voice.wakeWordSaving}
        updateWakeWordEnabled={voice.updateWakeWordEnabled}
        wakeWordCaptureError={voice.wakeWordCaptureError}
        wakeWordStatus={voice.wakeWordStatus}
        wakeWordDetail={voice.wakeWordDetail}
        cocoSleeping={voice.cocoSleeping}
      />
      <div className="settings-avatar">
        <SettingsToggle
          id="show-desktop-avatar"
          title="Desktop avatar"
          description="Show Coco on your desktop. The menu bar icon stays available either way."
          checked={!editHideAvatar}
          disabled={avatarSaving}
          onChange={(shown) => updateAvatarVisibility(!shown)}
        />
        {avatarSaving && (
          <p role="status" className="settings-note">
            Applying…
          </p>
        )}
        {avatarSaveError && (
          <p role="alert" className="settings-error">
            {avatarSaveError}
          </p>
        )}
      </div>
    </section>
  );
}
