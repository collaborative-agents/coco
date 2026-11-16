import { app, Menu } from 'electron';
import { installDockUpdateMenu } from './dock-menu';

jest.mock('electron', () => ({
  app: { dock: { setMenu: jest.fn() } },
  Menu: { buildFromTemplate: jest.fn((template) => template) },
}));

describe('Dock update menu', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers a manual update check without hiding any windows', () => {
    const updater = {
      isSupported: () => true,
      checkForUpdates: jest.fn(async () => {}),
    };
    installDockUpdateMenu(updater, 'darwin');
    expect(app.dock?.setMenu).toHaveBeenCalledTimes(1);
    const items = (Menu.buildFromTemplate as jest.Mock).mock.calls[0][0];
    expect(items[0].label).toBe('Check for Updates…');
    items[0].click();
    expect(updater.checkForUpdates).toHaveBeenCalledWith(true);
  });

  it.each(['win32', 'linux'] as const)('does not access Dock on %s', (platform) => {
    installDockUpdateMenu({ isSupported: () => true, checkForUpdates: jest.fn() }, platform);
    expect(app.dock?.setMenu).not.toHaveBeenCalled();
  });

  it('does not offer unsupported development updates', () => {
    installDockUpdateMenu({ isSupported: () => false, checkForUpdates: jest.fn() }, 'darwin');
    expect(app.dock?.setMenu).not.toHaveBeenCalled();
  });
});
