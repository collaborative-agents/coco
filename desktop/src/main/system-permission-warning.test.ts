import {
  getSystemPermissionWarning,
  needsWindowsMicrophoneSettings,
  systemPermissionButtonLabel,
  systemPermissionSettingsUrl,
} from './system-permission-warning';

describe('system permission warning', () => {
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

  it('lists input and screen permissions when both are unavailable', () => {
    expect(
      getSystemPermissionWarning('darwin', {
        accessibilityTrusted: false,
        screenCaptureStatus: 'denied',
      }),
    ).toMatchObject({
      settingsTargets: [
        'accessibility',
        'input-monitoring',
        'screen-recording',
      ],
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

  it('requires Windows microphone settings only when access is unavailable', () => {
    expect(needsWindowsMicrophoneSettings('win32', 'denied')).toBe(true);
    expect(needsWindowsMicrophoneSettings('win32', 'granted')).toBe(false);
    expect(needsWindowsMicrophoneSettings('darwin', 'denied')).toBe(false);
  });
});
