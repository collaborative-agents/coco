import fs from 'fs';
import path from 'path';
import {
  app,
  BrowserWindow,
  screen,
  systemPreferences,
  type IpcMain,
  type WebContents,
} from 'electron';
import log from 'electron-log';
import { resolveHtmlPath } from '../util';
import {
  WakeWordService,
  type WakeWordStatusEvent,
} from '../services/wake-word-service';

const DEFAULT_ENABLED = true;
const KEYWORDS = ['COCO', 'HI COCO', 'HEY COCO'] as const;
const MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

export interface WakeWordControllerOptions {
  preloadPath: () => string;
  getChatWindow: () => BrowserWindow | null;
  isSleeping: () => boolean;
  isSystemSuspended: () => boolean;
  startNewSession: () => Promise<void>;
}

export default class WakeWordController {
  private readonly options: WakeWordControllerOptions;

  private service: WakeWordService | null = null;

  private captureWindow: BrowserWindow | null = null;

  private enabled = DEFAULT_ENABLED;

  private status: WakeWordStatusEvent = { status: 'disabled' };

  private capturePaused = false;

  private capturePauseTimer: ReturnType<typeof setTimeout> | null = null;

  private captureState = 'stopped';

  private detectionSequence = 0;

  private pendingDetection: {
    id: number;
    keyword: string;
    attempts: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(options: WakeWordControllerOptions) {
    this.options = options;
  }

  initialize(): void {
    if (this.service) return;
    this.enabled = this.readEnabled();
    const modelDir = app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'wake-word', MODEL)
      : path.resolve(process.cwd(), 'assets', 'wake-word', MODEL);
    const executable = app.isPackaged
      ? path.join(
          process.resourcesPath,
          'service-dist',
          'coco-services',
          process.platform === 'win32'
            ? 'wake-word-worker.exe'
            : 'wake-word-worker',
        )
      : undefined;
    this.service = new WakeWordService({
      projectRoot: app.isPackaged
        ? process.resourcesPath
        : path.resolve(process.cwd(), '..'),
      modelDir,
      stateDir: path.join(app.getPath('userData'), 'wake-word'),
      logPath: path.join(app.getPath('userData'), 'logs', 'wake-word.log'),
      packagedExecutable: executable,
      onStatus: (status) => this.publishStatus(status),
      onDetected: (keyword) => {
        if (
          !this.enabled ||
          this.options.isSleeping() ||
          this.options.isSystemSuspended()
        ) {
          return;
        }
        log.info(`[Wake word] Detected ${keyword}`);
        this.queueDetection(keyword);
      },
    });
    this.sync();
  }

  createCaptureWindow(): void {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) return;
    const { x, y } = screen.getPrimaryDisplay().workArea;
    this.captureWindow = new BrowserWindow({
      show: false,
      x,
      y,
      width: 1,
      height: 1,
      opacity: 0,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: this.options.preloadPath(),
        backgroundThrottling: false,
      },
    });
    this.captureWindow.setIgnoreMouseEvents(true);
    this.captureWindow.setAlwaysOnTop(true, 'floating');
    this.captureWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
    this.captureWindow.loadURL(
      `${resolveHtmlPath('index.html')}?view=wake-word-capture`,
    );
    this.captureWindow.webContents.on(
      'render-process-gone',
      (_event, details) => {
        log.error(
          `[Wake word] Capture renderer exited: ${details.reason} (${details.exitCode})`,
        );
      },
    );
    this.captureWindow.on('closed', () => {
      this.captureWindow = null;
    });
  }

  registerIpc(ipcMain: IpcMain): void {
    ipcMain.removeHandler('get-wake-word-settings');
    ipcMain.handle('get-wake-word-settings', () => this.settings(true));

    ipcMain.removeHandler('set-wake-word-settings');
    ipcMain.handle(
      'set-wake-word-settings',
      async (_event, { enabled }: { enabled?: boolean } = {}) => {
        if (typeof enabled !== 'boolean') {
          return { success: false, error: 'Invalid voice activation setting.' };
        }
        if (
          enabled &&
          process.platform === 'darwin' &&
          systemPreferences.getMediaAccessStatus('microphone') !== 'granted'
        ) {
          const granted =
            await systemPreferences.askForMediaAccess('microphone');
          if (!granted) {
            return {
              success: false,
              error:
                'Microphone access is required. Enable Coco under Privacy & Security → Microphone.',
            };
          }
        }
        this.enabled = enabled;
        if (!enabled) this.setCapturePaused(false);
        this.saveEnabled(enabled);
        this.sync();
        const settings = this.settings();
        this.options
          .getChatWindow()
          ?.webContents.send('wake-word-settings-changed', settings);
        this.captureWindow?.webContents.send(
          'wake-word-settings-changed',
          settings,
        );
        return { success: true, ...settings };
      },
    );

    ipcMain.removeHandler('set-wake-word-capture-paused');
    ipcMain.handle(
      'set-wake-word-capture-paused',
      (_event, { paused }: { paused?: boolean } = {}) => {
        if (typeof paused !== 'boolean') return { success: false };
        this.setCapturePaused(paused);
        return { success: true, paused };
      },
    );

    ipcMain.removeAllListeners('wake-word-capture-renderer-ready');
    ipcMain.on('wake-word-capture-renderer-ready', (event) => {
      if (!this.isCaptureSender(event.sender) || !this.captureWindow) return;
      this.captureWindow.showInactive();
      this.captureWindow.webContents.send(
        'wake-word-settings-changed',
        this.settings(),
      );
      setImmediate(() => {
        this.captureWindow?.webContents.send('wake-word-capture-window-ready');
      });
      log.info('[Wake word] Microphone capture renderer ready');
    });

    ipcMain.removeAllListeners('wake-word-detection-ack');
    ipcMain.on(
      'wake-word-detection-ack',
      (event, value: { id?: unknown } | undefined) => {
        const chatWindow = this.options.getChatWindow();
        if (!chatWindow || event.sender !== chatWindow.webContents) return;
        const id = typeof value?.id === 'number' ? value.id : undefined;
        this.acknowledgeDetection(id);
      },
    );

    ipcMain.removeAllListeners('wake-word-capture-status');
    ipcMain.on('wake-word-capture-status', (event, status: unknown) => {
      if (!this.isCaptureSender(event.sender)) return;
      const payload = (status ?? {}) as { state?: unknown; detail?: unknown };
      const state =
        typeof payload.state === 'string' ? payload.state : 'unknown';
      if (!state || (state === this.captureState && !payload.detail)) return;
      this.captureState = state;
      const detail =
        typeof payload.detail === 'string' ? `: ${payload.detail}` : '';
      log.info(`[Wake word] Microphone capture ${state}${detail}`);
      this.options
        .getChatWindow()
        ?.webContents.send('wake-word-capture-status', {
          state,
          detail:
            typeof payload.detail === 'string' ? payload.detail : undefined,
        });
    });

    ipcMain.removeAllListeners('wake-word-audio-frame');
    ipcMain.on('wake-word-audio-frame', (event, payload: unknown) => {
      if (!this.isCaptureSender(event.sender)) return;
      if (
        !this.enabled ||
        this.options.isSleeping() ||
        this.options.isSystemSuspended() ||
        this.capturePaused ||
        !this.service
      ) {
        return;
      }
      if (payload instanceof Uint8Array) {
        this.service.writeAudio(Buffer.from(payload));
      } else if (payload instanceof ArrayBuffer) {
        this.service.writeAudio(Buffer.from(new Uint8Array(payload)));
      }
    });
  }

  sync(): void {
    if (!this.service) return;
    if (!this.enabled) this.service.stop('disabled');
    else if (this.options.isSleeping() || this.options.isSystemSuspended()) {
      this.service.stop('sleeping');
    } else this.service.start();
  }

  stop(): void {
    this.service?.stop('disabled');
  }

  notifySleepMode(sleeping: boolean): void {
    this.captureWindow?.webContents.send('coco-sleep-mode-changed', {
      sleeping,
    });
  }

  private settings(includeLogPath = false) {
    return {
      enabled: this.enabled,
      keywords: [...KEYWORDS],
      capturePaused: this.capturePaused,
      ...this.status,
      ...(includeLogPath
        ? {
            logPath: path.join(
              app.getPath('userData'),
              'logs',
              'wake-word.log',
            ),
          }
        : {}),
    };
  }

  // eslint-disable-next-line class-methods-use-this
  private settingsPath(): string {
    return path.join(app.getPath('userData'), 'wake-word.json');
  }

  private readEnabled(): boolean {
    const settingsPath = this.settingsPath();
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
        enabled?: unknown;
      };
      if (typeof saved?.enabled !== 'boolean') {
        throw new Error('saved enabled value is missing or invalid');
      }
      log.info(
        `[Wake word] Loaded enabled=${saved.enabled} from ${settingsPath}`,
      );
      return saved.enabled;
    } catch (error) {
      log.info(
        `[Wake word] No saved setting at ${settingsPath}; defaulting enabled (${(error as Error).message})`,
      );
      return DEFAULT_ENABLED;
    }
  }

  private saveEnabled(enabled: boolean): void {
    fs.writeFileSync(
      this.settingsPath(),
      `${JSON.stringify({ enabled }, null, 2)}\n`,
      'utf8',
    );
  }

  private publishStatus(status: WakeWordStatusEvent): void {
    this.status = status;
    this.options.getChatWindow()?.webContents.send('wake-word-status', status);
    if (status.detail)
      log.warn(`[Wake word] ${status.status}: ${status.detail}`);
    else log.info(`[Wake word] ${status.status}`);
  }

  private setCapturePaused(paused: boolean): void {
    this.capturePaused = paused;
    if (this.capturePauseTimer) clearTimeout(this.capturePauseTimer);
    this.capturePauseTimer = null;
    this.captureWindow?.webContents.send('wake-word-capture-paused-changed', {
      paused,
    });
    if (paused) {
      this.capturePauseTimer = setTimeout(() => {
        this.setCapturePaused(false);
      }, 45_000);
    }
  }

  private queueDetection(keyword: string): void {
    if (this.pendingDetection?.retryTimer) {
      clearTimeout(this.pendingDetection.retryTimer);
    }
    this.detectionSequence += 1;
    this.pendingDetection = {
      id: this.detectionSequence,
      keyword,
      attempts: 0,
      retryTimer: null,
    };
    this.setCapturePaused(true);
    this.options
      .startNewSession()
      .catch((error) =>
        log.warn(`[Wake word] Could not start a fresh Coco session: ${error}`),
      );
    this.deliverPendingDetection();
  }

  private deliverPendingDetection(): void {
    const pending = this.pendingDetection;
    if (!pending) return;
    if (pending.attempts >= 30) {
      log.warn(
        `[Wake word] Chat did not acknowledge detection ${pending.id}; resuming listening`,
      );
      this.pendingDetection = null;
      this.setCapturePaused(false);
      return;
    }
    pending.attempts += 1;
    const chatWindow = this.options.getChatWindow();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('wake-word-detected', {
        id: pending.id,
        keyword: pending.keyword,
      });
    }
    pending.retryTimer = setTimeout(() => this.deliverPendingDetection(), 500);
  }

  private acknowledgeDetection(id?: number): void {
    if (!this.pendingDetection || this.pendingDetection.id !== id) return;
    if (this.pendingDetection.retryTimer) {
      clearTimeout(this.pendingDetection.retryTimer);
    }
    log.info(
      `[Wake word] Chat acknowledged detection ${id} after ${this.pendingDetection.attempts} attempt(s)`,
    );
    this.pendingDetection = null;
  }

  private isCaptureSender(sender: WebContents): boolean {
    return Boolean(
      this.captureWindow &&
        !this.captureWindow.isDestroyed() &&
        this.captureWindow.webContents.id === sender.id,
    );
  }
}
