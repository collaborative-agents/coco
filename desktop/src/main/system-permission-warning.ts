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
    requirements.push('Accessibility and Input Monitoring');
    settingsTargets.push('accessibility', 'input-monitoring');
  }
  if (missingScreenCapture) {
    requirements.push('Screen Recording');
    settingsTargets.push('screen-recording');
  }

  return {
    message: 'Coco needs permission to observe your activity.',
    detail: `${requirements.join(
      ' and ',
    )} ${requirements.length === 1 ? 'is' : 'are'} not enabled. Without these permissions, Coco may stay open but its History and proactive suggestions will stop updating. Enable Coco in System Settings, then quit and reopen Coco.`,
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
