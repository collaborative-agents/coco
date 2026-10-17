import type { BrowserWindow } from 'electron';

type MainWindow = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces'
>;

/** The main app follows normal window stacking, unlike the desktop avatar. */
export default function configureMainWindow(
  window: MainWindow,
  platform: string = process.platform,
) {
  window.setAlwaysOnTop(false);
  if (platform === 'darwin') window.setVisibleOnAllWorkspaces(false);
}
