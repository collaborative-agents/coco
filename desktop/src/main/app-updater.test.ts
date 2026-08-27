import { EventEmitter } from 'events';
import type { UpdateInfo } from 'electron-updater';
import { DesktopAppUpdater, formatReleaseNotes } from './app-updater';

class FakeUpdater extends EventEmitter {
  allowPrerelease = true;

  autoDownload = true;

  autoInstallOnAppQuit = false;

  disableDifferentialDownload = true;

  disableWebInstaller = false;

  logger: unknown;

  checkForUpdates = jest.fn(async () => null);

  downloadUpdate = jest.fn(async () => []);
}

const updateInfo = {
  version: '0.1.1',
  files: [],
  path: 'coco-0.1.1-arm64-mac.zip',
  sha512: 'checksum',
  releaseDate: '2026-08-27T00:00:00.000Z',
  releaseNotes:
    '<ul><li>Faster updates</li><li>Fixes &amp; improvements</li></ul>',
} as UpdateInfo;

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const logger = () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
});

describe('DesktopAppUpdater', () => {
  afterEach(() => jest.useRealTimers());

  it('does not enable updates on unsupported desktop platforms', () => {
    const updater = new FakeUpdater();
    const manager = new DesktopAppUpdater({
      updater: updater as any,
      logger: logger(),
      isPackaged: true,
      platform: 'linux',
      currentVersion: () => '0.1.0',
      requestRestartAndInstall: jest.fn(),
    });

    manager.start();

    expect(manager.isSupported()).toBe(false);
    expect(updater.autoDownload).toBe(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('checks automatically without downloading until the user agrees', async () => {
    jest.useFakeTimers();
    const updater = new FakeUpdater();
    const showMessageBox = jest.fn(async () => ({ response: 0 }));
    const manager = new DesktopAppUpdater({
      updater: updater as any,
      logger: logger(),
      isPackaged: true,
      platform: 'darwin',
      currentVersion: () => '0.1.0',
      requestRestartAndInstall: jest.fn(),
      showMessageBox,
      showNotification: jest.fn(),
    });

    manager.start();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);

    updater.emit('update-available', updateInfo);
    await flushPromises();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Download Update', 'Later'],
        detail: expect.stringContaining(
          "What's new:\n\n• Faster updates\n\n• Fixes & improvements",
        ),
      }),
    );
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it('defers an automatic version for the rest of the session', async () => {
    jest.useFakeTimers();
    const updater = new FakeUpdater();
    const showMessageBox = jest.fn(async () => ({ response: 1 }));
    const manager = new DesktopAppUpdater({
      updater: updater as any,
      logger: logger(),
      isPackaged: true,
      platform: 'darwin',
      currentVersion: () => '0.1.0',
      requestRestartAndInstall: jest.fn(),
      showMessageBox,
      showNotification: jest.fn(),
    });
    manager.start();

    updater.emit('update-available', updateInfo);
    await flushPromises();
    updater.emit('update-available', updateInfo);
    await flushPromises();

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    manager.stop();
  });

  it('requests a graceful restart after an update is downloaded', async () => {
    jest.useFakeTimers();
    const updater = new FakeUpdater();
    const requestRestartAndInstall = jest.fn();
    const showMessageBox = jest.fn(async () => ({ response: 0 }));
    const manager = new DesktopAppUpdater({
      updater: updater as any,
      logger: logger(),
      isPackaged: true,
      platform: 'darwin',
      currentVersion: () => '0.1.0',
      requestRestartAndInstall,
      showMessageBox,
      showNotification: jest.fn(),
    });
    manager.start();

    updater.emit('update-downloaded', updateInfo);
    await flushPromises();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Restart and Install', 'Later'] }),
    );
    expect(requestRestartAndInstall).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it('supports packaged Windows builds', () => {
    jest.useFakeTimers();
    const updater = new FakeUpdater();
    const manager = new DesktopAppUpdater({
      updater: updater as any,
      logger: logger(),
      isPackaged: true,
      platform: 'win32',
      currentVersion: () => '0.1.0',
      requestRestartAndInstall: jest.fn(),
      showMessageBox: jest.fn(async () => ({ response: 1 })),
      showNotification: jest.fn(),
    });

    manager.start();

    expect(manager.isSupported()).toBe(true);
    expect(updater.autoDownload).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(false);
    manager.stop();
  });

  it('formats multi-version release notes and limits their size', () => {
    const notes = formatReleaseNotes([
      { version: '0.1.2', note: '<p>Newest &amp; fastest</p>' },
      { version: '0.1.1', note: `<p>${'x'.repeat(2_500)}</p>` },
    ]);

    expect(notes).toContain('Version 0.1.2\nNewest & fastest');
    expect(notes).toContain('Version 0.1.1');
    expect(notes).toHaveLength(2_000);
    expect(notes.endsWith('…')).toBe(true);
  });
});
