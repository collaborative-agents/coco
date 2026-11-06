import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

type CompanionWindow = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces'
>;

/** macOS panels can accompany another app's fullscreen Space without
 * changing the activation policy of the entire Coco application. */
export function fullscreenCompanionOptions(
  platform: string = process.platform,
): BrowserWindowConstructorOptions {
  return platform === 'darwin' ? { type: 'panel', fullscreenable: false } : {};
}

/**
 * Keep a lightweight companion surface above the user's current app, including
 * inside another app's macOS fullscreen Space.
 */
export default function configureFullscreenCompanionWindow(
  window: CompanionWindow,
  platform: string = process.platform,
): void {
  window.setAlwaysOnTop(true, 'floating');
  if (platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }
}
