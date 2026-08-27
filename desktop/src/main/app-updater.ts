import { Notification, dialog } from 'electron';
import type { MessageBoxOptions } from 'electron';
import type {
  AppUpdater as ElectronAppUpdater,
  ProgressInfo,
  UpdateInfo,
} from 'electron-updater';

const STARTUP_CHECK_DELAY_MS = 10_000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RELEASE_NOTES_LENGTH = 2_000;

const decodeHtmlEntities = (value: string): string =>
  value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code: string) => {
      const normalized = code.toLowerCase();
      if (normalized.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }
      if (normalized.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }
      return (
        {
          amp: '&',
          apos: "'",
          gt: '>',
          lt: '<',
          nbsp: ' ',
          quot: '"',
        } as Record<string, string>
      )[normalized];
    },
  );

const releaseNoteText = (value: string): string =>
  decodeHtmlEntities(
    value
      .replace(/<li(?:\s[^>]*)?>/gi, '\n• ')
      .replace(/<\/(?:li|p|div|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const formatReleaseNotes = (
  notes: UpdateInfo['releaseNotes'],
): string => {
  const text = Array.isArray(notes)
    ? notes
        .map(({ version, note }) => {
          const cleaned = releaseNoteText(note ?? '');
          return cleaned ? `Version ${version}\n${cleaned}` : '';
        })
        .filter(Boolean)
        .join('\n\n')
    : releaseNoteText(notes ?? '');
  if (text.length <= MAX_RELEASE_NOTES_LENGTH) return text;
  return `${text.slice(0, MAX_RELEASE_NOTES_LENGTH - 1).trimEnd()}…`;
};

interface UpdateLogger {
  debug(message?: unknown, ...optionalParameters: unknown[]): void;
  error(message?: unknown, ...optionalParameters: unknown[]): void;
  info(message?: unknown, ...optionalParameters: unknown[]): void;
  warn(message?: unknown, ...optionalParameters: unknown[]): void;
}

type Updater = Pick<
  ElectronAppUpdater,
  | 'allowPrerelease'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'disableDifferentialDownload'
  | 'disableWebInstaller'
  | 'logger'
  | 'on'
>;

export interface DesktopAppUpdaterDependencies {
  updater: Updater;
  logger: UpdateLogger;
  isPackaged: boolean;
  platform: typeof process.platform;
  currentVersion: () => string;
  requestRestartAndInstall: () => void;
  showMessageBox?: (
    options: MessageBoxOptions,
  ) => Promise<{ response: number }>;
  showNotification?: (title: string, body: string) => void;
}

export class DesktopAppUpdater {
  private readonly updater: Updater;

  private readonly logger: UpdateLogger;

  private readonly supported: boolean;

  private readonly currentVersion: () => string;

  private readonly requestRestartAndInstall: () => void;

  private readonly showMessageBox: NonNullable<
    DesktopAppUpdaterDependencies['showMessageBox']
  >;

  private readonly showNotification: NonNullable<
    DesktopAppUpdaterDependencies['showNotification']
  >;

  private started = false;

  private checking = false;

  private manualCheck = false;

  private activeDownloadVersion: string | null = null;

  private lastProgressBucket = -1;

  private readonly deferredVersions = new Set<string>();

  private readonly handledDownloads = new Set<string>();

  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: DesktopAppUpdaterDependencies) {
    this.updater = dependencies.updater;
    this.logger = dependencies.logger;
    this.supported =
      (dependencies.platform === 'darwin' ||
        dependencies.platform === 'win32') &&
      dependencies.isPackaged;
    this.currentVersion = dependencies.currentVersion;
    this.requestRestartAndInstall = dependencies.requestRestartAndInstall;
    this.showMessageBox =
      dependencies.showMessageBox ??
      ((options) => dialog.showMessageBox(options));
    this.showNotification =
      dependencies.showNotification ??
      ((title, body) => {
        if (Notification.isSupported()) {
          new Notification({ title, body }).show();
        }
      });
  }

  isSupported(): boolean {
    return this.supported;
  }

  start(): void {
    if (!this.supported || this.started) return;
    this.started = true;

    this.updater.logger = this.logger;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = false;
    this.updater.disableDifferentialDownload = false;
    this.updater.disableWebInstaller = true;

    this.updater.on('update-available', (info: UpdateInfo) => {
      const manual = this.manualCheck;
      if (!manual && this.deferredVersions.has(info.version)) return;
      this.offerDownload(info).catch((error) =>
        this.logger.error(`[Updater] Could not show update offer: ${error}`),
      );
    });
    this.updater.on('update-not-available', () => {
      if (!this.manualCheck) return;
      this.showMessageBox({
        type: 'info',
        title: 'Coco is up to date',
        message: `Coco ${this.currentVersion()} is the newest version.`,
        buttons: ['OK'],
      }).catch((error) =>
        this.logger.error(`[Updater] Could not show update status: ${error}`),
      );
    });
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      const bucket = Math.floor(progress.percent / 10);
      if (bucket === this.lastProgressBucket) return;
      this.lastProgressBucket = bucket;
      this.logger.info(
        `[Updater] Downloading ${this.activeDownloadVersion ?? 'update'}: ${progress.percent.toFixed(1)}%`,
      );
    });
    this.updater.on('update-downloaded', (info: UpdateInfo) => {
      this.offerInstall(info).catch((error) =>
        this.logger.error(`[Updater] Could not show install offer: ${error}`),
      );
    });
    this.updater.on('error', (error: Error) => {
      // eslint-disable-next-line promise/no-promise-in-callback
      this.handleError(error).catch((dialogError) =>
        this.logger.error(
          `[Updater] Could not show update error: ${dialogError}`,
        ),
      );
    });

    this.startupTimer = setTimeout(() => {
      this.checkForUpdates().catch((error) =>
        this.logger.error(`[Updater] Scheduled update check failed: ${error}`),
      );
    }, STARTUP_CHECK_DELAY_MS);
    this.startupTimer.unref?.();

    this.periodicTimer = setInterval(() => {
      this.checkForUpdates().catch((error) =>
        this.logger.error(`[Updater] Periodic update check failed: ${error}`),
      );
    }, PERIODIC_CHECK_INTERVAL_MS);
    this.periodicTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
  }

  async checkForUpdates(manual = false): Promise<void> {
    if (!this.supported || this.checking) return;
    this.checking = true;
    this.manualCheck = manual;
    this.logger.info(
      `[Updater] Checking for updates${manual ? ' (requested by user)' : ''}.`,
    );
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      // electron-updater also emits an error event. Keep this catch to avoid an
      // unhandled rejection without showing the same dialog twice.
      this.logger.error(`[Updater] Update check failed: ${String(error)}`);
    } finally {
      this.manualCheck = false;
      this.checking = false;
    }
  }

  private async offerDownload(info: UpdateInfo): Promise<void> {
    if (this.activeDownloadVersion || this.handledDownloads.has(info.version)) {
      return;
    }
    const releaseNotes = formatReleaseNotes(info.releaseNotes);
    const downloadQuestion =
      'Download it now? Coco will keep running while the update downloads.';
    const { response } = await this.showMessageBox({
      type: 'info',
      title: 'A Coco update is available',
      message: `Coco ${info.version} is available.`,
      detail: releaseNotes
        ? `What's new:\n\n${releaseNotes}\n\n${downloadQuestion}`
        : downloadQuestion,
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) {
      this.deferredVersions.add(info.version);
      this.logger.info(`[Updater] Deferred version ${info.version}.`);
      return;
    }

    this.activeDownloadVersion = info.version;
    this.lastProgressBucket = -1;
    this.showNotification(
      `Downloading Coco ${info.version}`,
      'Coco will let you know when the update is ready to install.',
    );
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      // The error event owns the user-facing failure message.
      this.logger.error(`[Updater] Update download failed: ${String(error)}`);
    }
  }

  private async offerInstall(info: UpdateInfo): Promise<void> {
    if (this.handledDownloads.has(info.version)) return;
    this.handledDownloads.add(info.version);
    this.activeDownloadVersion = null;
    this.showNotification(
      `Coco ${info.version} is ready`,
      'Restart Coco to finish installing the update.',
    );
    const { response } = await this.showMessageBox({
      type: 'info',
      title: 'Update ready to install',
      message: `Coco ${info.version} has been downloaded.`,
      detail:
        'Restart now to install it, or choose Later and it will install when Coco quits.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) this.requestRestartAndInstall();
  }

  private async handleError(error: Error): Promise<void> {
    const failedDownload = this.activeDownloadVersion;
    const requestedCheck = this.manualCheck;
    this.activeDownloadVersion = null;
    this.logger.error(`[Updater] ${error.stack ?? error.message}`);
    if (!failedDownload && !requestedCheck) return;

    await this.showMessageBox({
      type: 'error',
      title: failedDownload
        ? 'Coco could not download the update'
        : 'Coco could not check for updates',
      message: 'Please check your internet connection and try again later.',
      buttons: ['OK'],
    });
  }
}
