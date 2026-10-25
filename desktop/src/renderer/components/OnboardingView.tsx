import { useEffect, useState } from 'react';
import SetupShell from './setup/SetupShell';
import WelcomeStep from './onboarding/WelcomeStep';
import NameStep from './onboarding/NameStep';
import PermissionsStep from './onboarding/PermissionsStep';
import VoiceStep from './onboarding/VoiceStep';
import AvatarStep from './onboarding/AvatarStep';
import ModelsStep from './onboarding/ModelsStep';
import useModelSetup from './onboarding/useModelSetup';
import './OnboardingView.css';
import './onboarding/ModelSetup.css';

const PAGES = {
  models: {
    title: 'Connect Coco to your models',
    description:
      'Choose the models that help Coco understand your work and respond to you.',
  },
  welcome: {
    title: 'Meet Coco, your proactive co-assistant',
    description:
      'A companion that understands your working context and offers help when you need it. Let’s make Coco feel at home.',
  },
  name: {
    title: 'What should Coco call you?',
    description:
      'Start with a name. Make your conversations with Coco a little more personal.',
  },
  permissions: {
    title: 'Permissions & privacy',
    description:
      'Coco needs a few permissions to understand your activity. Here’s what each one does and how your data is used.',
  },
  voice: {
    title: 'Hey Coco',
    description:
      'Start a conversation with your voice. This is optional — choose what feels right for you.',
  },
  avatar: {
    title: 'Ready to go',
    description:
      'Choose where Coco lives on your desktop. Your menu-bar icon will always be there for quick access to chat, history, and settings.',
  },
} as const;
type StepKey = keyof typeof PAGES;

export default function OnboardingView() {
  const query = new URLSearchParams(window.location.search);
  const modelsOnly = query.get('modelsOnly') === '1';
  const models = useModelSetup();
  const [currentKey, setCurrentKey] = useState<StepKey>(
    modelsOnly ? 'models' : 'welcome',
  );
  const [userName, setUserName] = useState('');
  const [nameError, setNameError] = useState('');
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [hideAvatar, setHideAvatar] = useState(false);

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile: any) => setUserName(String(profile?.userName ?? '')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.getElementById('coco-setup-title')?.focus();
    document.querySelector('.coco-setup-shell')?.scrollTo?.(0, 0);
  }, [currentKey]);

  const stepKeys: StepKey[] = modelsOnly
    ? ['models']
    : [
        'welcome',
        'name',
        'permissions',
        'voice',
        'models',
        'avatar',
      ];
  const step = stepKeys.indexOf(currentKey);
  const busy = models.savingModels || voiceBusy;
  const blocked = busy || (currentKey === 'permissions' && !permissionsReady);
  const isLast = step === stepKeys.length - 1;

  const finish = () => {
    window.electron?.ipcRenderer.sendMessage('onboarding-complete', {
      onboardingComplete: true,
      userName: userName.trim(),
      hideAvatar,
      tutorScenario: 'everyday_support',
      aiTools: [],
      customSystemPrompt: '',
      completedAt: new Date().toISOString(),
    });
    window.close();
  };

  const handleNext = async () => {
    if (blocked) return;
    if (currentKey === 'name' && !userName.trim()) {
      setNameError('Enter the name you want Coco to use.');
      document.getElementById('ob-user-name')?.focus();
      return;
    }
    if (currentKey === 'models') {
      const pi = await window.electron?.ipcRenderer.invoke('pi-provider', 'status');
      if (pi?.connection?.mode !== 'native' && !(await models.saveModels())) return;
      if (modelsOnly) {
        window.electron?.ipcRenderer.sendMessage(
          'model-configuration-complete',
        );
        window.close();
        return;
      }
    }
    if (isLast) finish();
    else setCurrentKey(stepKeys[step + 1]);
  };

  let nextLabel = 'Next';
  if (isLast) nextLabel = modelsOnly ? 'Save & start Coco' : 'Start Coco';
  if (busy) nextLabel = 'Saving…';

  return (
    <SetupShell
      label={modelsOnly ? 'Model setup' : 'Getting started'}
      title={PAGES[currentKey].title}
      illustration={null}
      description={PAGES[currentKey].description}
      closeLabel="Close setup for now"
      onClose={() =>
        window.electron?.ipcRenderer.sendMessage('hide-onboarding')
      }
      actions={
        <>
          <button
            type="button"
            className="ob-btn ob-btn-primary"
            onClick={handleNext}
            disabled={blocked}
          >
            {nextLabel}
          </button>
          {step > 0 && (
            <button
              type="button"
              className="ob-btn ob-btn-ghost"
              disabled={busy}
              onClick={() => setCurrentKey(stepKeys[step - 1])}
            >
              Back
            </button>
          )}
        </>
      }
      footer={
        <>
          <div className="ob-progress" aria-label="Setup progress">
            {stepKeys.map((key, index) => (
              <span
                key={key}
                className={index === step ? 'active' : ''}
                aria-current={index === step ? 'step' : undefined}
                aria-label={PAGES[key].title}
              />
            ))}
          </div>
          <span>
            {step + 1} / {stepKeys.length}
          </span>
        </>
      }
    >
      {currentKey === 'welcome' && <WelcomeStep />}
      {currentKey === 'name' && (
        <NameStep
          value={userName}
          onChange={(value) => {
            setUserName(value);
            setNameError('');
          }}
          error={nameError}
          onNext={handleNext}
        />
      )}
      {currentKey === 'permissions' && (
        <PermissionsStep
          onReady={setPermissionsReady}
        />
      )}
      {currentKey === 'voice' && <VoiceStep onBusy={setVoiceBusy} />}
      {currentKey === 'models' && (
        <div className="coco-setup-panel coco-setup-panel-padded">
          {/* Model fields and their actions are owned by the setup hook. */}
          {/* eslint-disable-next-line react/jsx-props-no-spreading */}
          <ModelsStep {...models.modelProps} />
        </div>
      )}
      {currentKey === 'avatar' && (
        <AvatarStep hidden={hideAvatar} onChange={setHideAvatar} />
      )}
    </SetupShell>
  );
}
