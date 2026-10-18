import {
  getSystemPermissionWarning,
  needsWindowsMicrophoneSettings,
  systemPermissionButtonLabel,
  systemPermissionExplanation,
  systemPermissionSettingsUrl,
} from './system-permission-warning';

describe('system permission warning', () => {
  it('skips granted Accessibility and offers Screen Recording only', () => {
    expect(getSystemPermissionWarning('darwin', {
      accessibilityTrusted: true,
      screenCaptureStatus: 'denied',
    })?.settingsTargets).toEqual(['screen-recording']);
  });

  it('skips granted Screen Recording and offers Accessibility only', () => {
    expect(getSystemPermissionWarning('darwin', {
      accessibilityTrusted: false,
      screenCaptureStatus: 'granted',
    })?.settingsTargets).toEqual(['accessibility']);
  });
  it('does not show the macOS consent warning on Windows', () => {
    expect(
      getSystemPermissionWarning('win32', {
        accessibilityTrusted: false,
        screenCaptureStatus: 'denied',
      }),
    ).toBeNull();
  });

  it('does not warn when all required macOS permissions are enabled', () => {
    expect(
      getSystemPermissionWarning('darwin', {
        accessibilityTrusted: true,
        screenCaptureStatus: 'granted',
      }),
    ).toBeNull();
  });

  it('lists only permissions actually checked, not an inferred Input Monitoring status', () => {
    expect(
      getSystemPermissionWarning('darwin', {
        accessibilityTrusted: false,
        screenCaptureStatus: 'denied',
      }),
    ).toMatchObject({
      settingsTargets: ['accessibility', 'screen-recording'],
    });
  });

  it('links each button to the matching macOS privacy pane', () => {
    expect(systemPermissionButtonLabel('input-monitoring')).toBe(
      'Open Input Monitoring',
    );
    expect(systemPermissionSettingsUrl('input-monitoring')).toContain(
      'Privacy_ListenEvent',
    );
  });

  it('explains why Screen Recording and Accessibility are required', () => {
    expect(systemPermissionExplanation('screen-recording')).toBe(
      'Coco Learn uses screenshots to understand your current task and offer relevant assistance. Screenshots are deleted after processing and are not collected.',
    );
    expect(systemPermissionExplanation('accessibility')).toBe(
      'Coco Learn uses Accessibility access to detect keyboard and mouse activity so it can understand when your task changes. Raw keyboard and mouse activity is processed locally and is not uploaded or sent to a model.',
    );
  });

  it('requires Windows microphone settings only when access is unavailable', () => {
    expect(needsWindowsMicrophoneSettings('win32', 'denied')).toBe(true);
    expect(needsWindowsMicrophoneSettings('win32', 'granted')).toBe(false);
    expect(needsWindowsMicrophoneSettings('darwin', 'denied')).toBe(false);
  });
});
