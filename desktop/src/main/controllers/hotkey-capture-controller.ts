import {
  BrowserWindow,
  desktopCapturer,
  screen,
  type IpcMain,
  type WebContents,
} from 'electron';
import log from 'electron-log';
import { resolveHtmlPath } from '../util';

type AnnotationResult = 'replace' | 'attach';

export interface HotkeyCaptureControllerOptions {
  preloadPath: () => string;
  createChatWindow: () => void;
  getChatWindow: () => BrowserWindow | null;
  startNewSession: () => Promise<void>;
}

export default class HotkeyCaptureController {
  private readonly options: HotkeyCaptureControllerOptions;

  private previewWindow: BrowserWindow | null = null;

  private previewDataUrl: string | null = null;

  private previewEditable = false;

  private previewSourceWindow: BrowserWindow | null = null;

  private annotationResult: AnnotationResult = 'replace';

  private fullScreenOverlay = false;

  private captureInProgress = false;

  private pendingCaptures: string[] = [];

  private rendererReady = false;

  constructor(options: HotkeyCaptureControllerOptions) {
    this.options = options;
  }

  get isRendererReady(): boolean {
    return this.rendererReady;
  }

  markRendererNotReady(): void {
    this.rendererReady = false;
  }

  markRendererReady(): void {
    this.rendererReady = true;
    this.flushPendingCaptures();
  }

  registerIpc(ipcMain: IpcMain): void {
    ipcMain.removeAllListeners('open-image-preview');
    ipcMain.on('open-image-preview', (event, payload: unknown) => {
      const preview = (payload ?? {}) as {
        imageDataUrl?: unknown;
        editable?: unknown;
      };
      if (
        typeof preview.imageDataUrl !== 'string' ||
        !preview.imageDataUrl.startsWith('data:image/')
      ) {
        log.warn('[ImagePreview] Ignored an invalid image preview request.');
        return;
      }
      this.openPreview(
        BrowserWindow.fromWebContents(event.sender),
        preview.imageDataUrl,
        preview.editable === true,
      );
    });

    ipcMain.removeAllListeners('image-preview-ready');
    ipcMain.on('image-preview-ready', (event) => {
      this.handlePreviewReady(event.sender);
    });

    ipcMain.removeAllListeners('close-image-preview');
    ipcMain.on('close-image-preview', (event) => {
      this.closePreview(event.sender);
    });

    ipcMain.removeAllListeners('save-image-annotation');
    ipcMain.on('save-image-annotation', (event, payload: unknown) => {
      this.saveAnnotation(event.sender, payload);
    });
  }

  flushPendingCaptures(): void {
    const chatWindow = this.options.getChatWindow();
    if (
      !this.rendererReady ||
      !chatWindow ||
      chatWindow.isDestroyed() ||
      this.pendingCaptures.length === 0
    ) {
      return;
    }
    const captures = this.pendingCaptures;
    this.pendingCaptures = [];
    captures.forEach((imageDataUrl) => {
      chatWindow.webContents.send('hotkey-capture', { imageDataUrl });
    });
  }

  async beginCapture(): Promise<void> {
    if (this.captureInProgress) {
      log.info('[ImagePreview] Capture already in progress; ignoring repeat.');
      return;
    }
    if (this.previewWindow && !this.previewWindow.isDestroyed()) {
      this.previewWindow.show();
      this.previewWindow.focus();
      return;
    }

    this.captureInProgress = true;
    const startedAt = Date.now();
    try {
      const dataUrl = await this.captureDisplayAtCursor();
      this.options.createChatWindow();
      this.openPreview(
        this.options.getChatWindow(),
        dataUrl,
        true,
        'attach',
        true,
        true,
      );
      log.info(
        `[ImagePreview] Annotation overlay opened in ${Date.now() - startedAt}ms.`,
      );
    } catch (error) {
      log.error(
        `[ImagePreview] Direct screenshot capture failed: ${(error as Error).message}`,
      );
    } finally {
      this.captureInProgress = false;
    }
  }

  openPreview(
    sourceWindow: BrowserWindow | null,
    imageDataUrl: string,
    editable = false,
    annotationResult: AnnotationResult = 'replace',
    displayAtCursor = false,
    fullScreenOverlay = false,
  ): void {
    this.previewDataUrl = imageDataUrl;
    this.previewEditable = editable;
    this.previewSourceWindow = sourceWindow;
    this.annotationResult = annotationResult;
    this.fullScreenOverlay = fullScreenOverlay;
    const display =
      sourceWindow && !displayAtCursor
        ? screen.getDisplayMatching(sourceWindow.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    if (this.previewWindow && !this.previewWindow.isDestroyed()) {
      if (
        process.platform === 'darwin' &&
        this.previewWindow.isSimpleFullScreen()
      ) {
        this.previewWindow.setSimpleFullScreen(false);
      }
      this.previewWindow.setBounds(display.bounds);
      if (process.platform === 'darwin') {
        this.previewWindow.setSimpleFullScreen(true);
      }
      if (!this.previewWindow.webContents.isLoadingMainFrame()) {
        this.sendPreview();
      }
      return;
    }

    const previewWindow = new BrowserWindow({
      show: false,
      ...display.bounds,
      frame: false,
      transparent: false,
      backgroundColor: '#111827',
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { preload: this.options.preloadPath() },
    });
    this.previewWindow = previewWindow;
    previewWindow.setAlwaysOnTop(
      true,
      process.platform === 'darwin' ? 'screen-saver' : 'floating',
    );
    if (process.platform === 'darwin') {
      previewWindow.setSimpleFullScreen(true);
    }
    previewWindow.loadURL(
      `${resolveHtmlPath('index.html')}?view=image-preview`,
    );
    previewWindow.on('closed', () => this.clearPreviewState(previewWindow));
  }

  handlePreviewReady(sender: WebContents): void {
    if (
      !this.previewWindow ||
      this.previewWindow.isDestroyed() ||
      this.previewWindow.webContents.id !== sender.id ||
      !this.previewDataUrl
    ) {
      return;
    }
    this.sendPreview();
  }

  closePreview(sender: WebContents): void {
    if (
      this.previewWindow &&
      !this.previewWindow.isDestroyed() &&
      this.previewWindow.webContents.id === sender.id
    ) {
      this.dismissPreview(this.previewWindow);
    }
  }

  saveAnnotation(sender: WebContents, payload: unknown): void {
    const annotatedImageDataUrl = (payload as { imageDataUrl?: unknown } | null)
      ?.imageDataUrl;
    if (
      !this.previewEditable ||
      !this.previewDataUrl ||
      !this.previewWindow ||
      this.previewWindow.isDestroyed() ||
      this.previewWindow.webContents.id !== sender.id ||
      typeof annotatedImageDataUrl !== 'string' ||
      !annotatedImageDataUrl.startsWith('data:image/png;base64,') ||
      annotatedImageDataUrl.length > 50_000_000
    ) {
      log.warn('[ImagePreview] Ignored an invalid annotation result.');
      return;
    }

    if (this.annotationResult === 'attach') {
      this.pendingCaptures.push(annotatedImageDataUrl);
      this.options
        .startNewSession()
        .catch((error) =>
          log.warn(
            `[ImagePreview] Could not start a fresh Coco session: ${error}`,
          ),
        );
      this.flushPendingCaptures();
    } else if (
      this.previewSourceWindow &&
      !this.previewSourceWindow.isDestroyed()
    ) {
      this.previewSourceWindow.webContents.send('image-annotation-saved', {
        originalImageDataUrl: this.previewDataUrl,
        imageDataUrl: annotatedImageDataUrl,
      });
    }
    this.dismissPreview(this.previewWindow);
  }

  // eslint-disable-next-line class-methods-use-this
  private async captureDisplayAtCursor(): Promise<string> {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const pixelSize = {
      width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(
        1,
        Math.round(display.size.height * display.scaleFactor),
      ),
    };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: pixelSize,
    });
    const source =
      sources.find(
        (candidate) => candidate.display_id === String(display.id),
      ) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(`No capture source found for display ${display.id}`);
    }
    const capturedSize = source.thumbnail.getSize();
    log.info(
      `[ImagePreview] Captured display ${display.id} at ` +
        `${capturedSize.width}x${capturedSize.height} ` +
        `(requested ${pixelSize.width}x${pixelSize.height}).`,
    );
    return source.thumbnail.toDataURL();
  }

  private sendPreview(): void {
    if (
      !this.previewWindow ||
      this.previewWindow.isDestroyed() ||
      !this.previewDataUrl
    ) {
      return;
    }
    this.previewWindow.webContents.send('image-preview', {
      imageDataUrl: this.previewDataUrl,
      editable: this.previewEditable,
      fullScreenOverlay: this.fullScreenOverlay,
    });
    if (
      process.platform === 'darwin' &&
      !this.previewWindow.isSimpleFullScreen()
    ) {
      this.previewWindow.setSimpleFullScreen(true);
    }
    this.previewWindow.show();
    this.previewWindow.focus();
  }

  private clearPreviewState(target: BrowserWindow): void {
    if (this.previewWindow !== target) return;
    this.previewWindow = null;
    this.previewDataUrl = null;
    this.previewEditable = false;
    this.previewSourceWindow = null;
    this.annotationResult = 'replace';
    this.fullScreenOverlay = false;
  }

  private dismissPreview(target: BrowserWindow): void {
    this.clearPreviewState(target);
    if (!target.isDestroyed()) target.destroy();
  }
}
