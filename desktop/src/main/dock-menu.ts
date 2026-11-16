import { app, Menu } from 'electron';
import type { DesktopAppUpdater } from './app-updater';

// Register after app.whenReady; macOS supplies its standard Dock items itself.
export function installDockUpdateMenu(
  updater: Pick<DesktopAppUpdater, 'isSupported' | 'checkForUpdates'>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'darwin' || !updater.isSupported() || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    {
      label: 'Check for Updates…',
      click: () => { void updater.checkForUpdates(true); },
    },
  ]));
}
