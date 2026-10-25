import type React from 'react';
import { S } from './styles';
import SettingsToggle from './SettingsToggle';

interface Props {
  wakeWordSaving: boolean;
  wakeWordEnabled: boolean;
  updateWakeWordEnabled: (enabled: boolean) => Promise<void>;
  wakeWordCaptureError: string;
  wakeWordStatus: 'disabled' | 'starting' | 'ready' | 'sleeping' | 'error';
  wakeWordDetail: string;
  cocoSleeping: boolean;
}

export default function VoiceSettings({
  wakeWordSaving,
  wakeWordEnabled,
  updateWakeWordEnabled,
  wakeWordCaptureError,
  wakeWordStatus,
  wakeWordDetail,
  cocoSleeping,
}: Props) {
  return (
    <div>
      <SettingsToggle
        id="workspace-voice-activation"
        title="Voice activation"
        description="Say “Coco”, “Hi Coco”, or “Hey Coco” to start talking."
        checked={wakeWordEnabled}
        disabled={wakeWordSaving}
        onChange={updateWakeWordEnabled}
      />
      <p className="settings-note">
        Wake-word audio is processed locally and discarded. Listening pauses
        while Coco sleeps or records a voice message.
      </p>
      {wakeWordEnabled && (
        <div
          role="status"
          style={{
            ...S.healthDetail,
            marginTop: 6,
            color:
              wakeWordCaptureError || wakeWordStatus === 'error'
                ? '#b91c1c'
                : '#16a34a',
          }}
        >
          {wakeWordCaptureError
            ? `Microphone unavailable: ${wakeWordCaptureError}`
            : wakeWordStatus === 'error'
              ? wakeWordDetail || 'The local wake-word model could not start.'
              : cocoSleeping || wakeWordStatus === 'sleeping'
                ? 'Paused while Coco is asleep.'
                : wakeWordStatus === 'starting'
                  ? 'Starting the local detector…'
                  : 'Listening locally.'}
        </div>
      )}
    </div>
  );
}
