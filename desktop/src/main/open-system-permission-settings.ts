import {
  systemPermissionSettingsUrl,
  type SystemPermissionSettingsTarget,
} from './system-permission-warning';

interface PermissionSettingsDependencies {
  screenStatus: () => string;
  requestScreenAccess: () => Promise<unknown>;
  openExternal: (url: string) => Promise<unknown>;
  warn: (message: string) => void;
}

/** Called only after the user explicitly chooses a permission-settings button. */
export async function openSystemPermissionSettings(
  target: SystemPermissionSettingsTarget,
  deps: PermissionSettingsDependencies,
): Promise<void> {
  if (
    target === 'screen-recording' &&
    ['denied', 'not-determined', 'unknown'].includes(deps.screenStatus())
  ) {
    // Chromium reports screen capture as denied both before the first request
    // and after a refusal. macOS may not list the app until it has exercised a
    // capture API, so request access for either case. Electron can leave
    // getSources pending while consent is unanswered, so don't let that prevent
    // the user from reaching System Settings. No images are saved.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => deps.requestScreenAccess())
          .catch((error) => {
            deps.warn(
              `Screen permission request did not complete: ${String(error)}`,
            );
          }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  await deps.openExternal(systemPermissionSettingsUrl(target));
}
