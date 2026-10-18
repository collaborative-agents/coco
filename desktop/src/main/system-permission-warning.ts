export type SystemPermissionSettingsTarget =
  | 'accessibility'
  | 'input-monitoring'
  | 'screen-recording';

export interface SystemPermissionWarning {
  message: string;
  detail: string;
  settingsTargets: SystemPermissionSettingsTarget[];
}

export interface SystemPermissionState {
  accessibilityTrusted: boolean;
  screenCaptureStatus:
    | 'not-determined'
    | 'granted'
    | 'denied'
    | 'restricted'
    | 'unknown';
}

export const needsWindowsMicrophoneSettings = (
  platform: NodeJS.Platform,
  microphoneStatus: SystemPermissionState['screenCaptureStatus'],
): boolean => platform === 'win32' && microphoneStatus !== 'granted';

/**
 * macOS protects the global input hooks and screen capture used by sensing.
 * Windows does not expose equivalent consent panes for desktop input hooks or
 * screen capture, so showing this warning there would send users to settings
 * that cannot fix anything.
 */
export const getSystemPermissionWarning = (
  platform: NodeJS.Platform,
  state: SystemPermissionState,
): SystemPermissionWarning | null => {
  if (platform !== 'darwin') return null;

  const missingAccessibility = !state.accessibilityTrusted;
  const missingScreenCapture = state.screenCaptureStatus !== 'granted';
  if (!missingAccessibility && !missingScreenCapture) return null;

  const requirements: string[] = [];
  const settingsTargets: SystemPermissionSettingsTarget[] = [];

  if (missingAccessibility) {
    requirements.push('Accessibility');
    settingsTargets.push('accessibility');
  }
  if (missingScreenCapture) {
    requirements.push('Screen Recording');
    settingsTargets.push('screen-recording');
  }

  return {
    message: 'Coco needs permission to observe your activity.',
    detail: `${requirements.join(
      ' and ',
    )} ${requirements.length === 1 ? 'is' : 'are'} not enabled. Without these permissions, History and proactive suggestions will not update. Open Screen Recording also requests macOS consent when needed; no screen image is saved by this permission check. If Coco Learn is missing from the list, use + to add it from Applications. Enable access, then quit and reopen Coco Learn. Missing permissions are shown under Coco Health in Settings.`,
    settingsTargets,
  };
};

export const systemPermissionSettingsUrl = (
  target: SystemPermissionSettingsTarget,
): string => {
  switch (target) {
    case 'accessibility':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    case 'input-monitoring':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
    case 'screen-recording':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
};

export const systemPermissionButtonLabel = (
  target: SystemPermissionSettingsTarget,
): string => {
  switch (target) {
    case 'accessibility':
      return 'Open Accessibility';
    case 'input-monitoring':
      return 'Open Input Monitoring';
    case 'screen-recording':
      return 'Open Screen Recording';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
};

export const systemPermissionExplanation = (
  target: SystemPermissionSettingsTarget,
): string => {
  switch (target) {
    case 'accessibility':
      return 'Coco Learn uses Accessibility access to detect keyboard and mouse activity so it can understand when your task changes. Raw keyboard and mouse activity is processed locally and is not uploaded or sent to a model.';
    case 'input-monitoring':
      return 'Coco Learn uses Input Monitoring access to detect keyboard activity so it can understand when your task changes. Raw keyboard activity is processed locally and is not uploaded or sent to a model.';
    case 'screen-recording':
      return 'Coco Learn uses screenshots to understand your current task and offer relevant assistance. Screenshots are deleted after processing and are not collected.';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
};
