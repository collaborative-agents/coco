/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import { exec, spawn } from 'child_process';
import {
  app,
  BrowserWindow,
  shell,
  clipboard,
  ipcMain,
  globalShortcut,
  Menu,
  Tray,
  nativeImage,
  dialog,
  screen,
  powerMonitor,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import axios from 'axios';
import { resolveHtmlPath } from './util';
import { serviceManager } from './services/manager';
import { configureServiceModelArguments } from './services/model-arguments';
import {
  startObservationStream,
  stopObservationStream,
  type ObservationEvent,
} from './services/observation-stream';
import {
  consumeTutorStream,
  TutorStreamTimeoutError,
} from './services/tutor-stream';
import type { TutorStreamEvent } from './services/tutor-stream';
import { PersonalizationScheduler } from './services/personalization-scheduler';
import { DailyMemoryDraftService } from './services/daily-memory-drafts';
import {
  appendActivity,
  readActivity,
  recordSupportEngagement,
  recordSupportRating,
  recordSupportSuggestion,
  pruneActivity,
} from './activity-store';
import {
  readConversations,
  saveConversation,
} from './conversation-store';
import {
  defaultTutor,
  getModelConfigurationView,
  prepareModelConnectionTest,
  readModelConfiguration,
  resolveModelRuntime,
  saveModelConfiguration,
  type ModelConfigurationInput,
  type ModelConnection,
} from './model-config-store';
import { ObservationSleepGuard } from './observation-sleep-guard';
import { cleanObservation, AI_TOOLS, resolveAiTools, parseAiTool } from '../renderer/components/observation-types';
import type {
  ObservationStatus,
  AiToolButton,
  LLMCallMetrics,
} from '../renderer/components/observation-types';

const dotenv = require('dotenv');

app.setName('coco');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// A dedicated development override makes first-launch testing reliable through
// npm's nested webpack/electronmon process tree. Chromium's --user-data-dir
// flag is not consistently forwarded by every npm/shell combination.
const developmentUserDataDir = process.env.COCO_DESKTOP_USER_DATA_DIR?.trim();
if (!app.isPackaged && developmentUserDataDir) {
  const resolvedUserDataDir = path.resolve(developmentUserDataDir);
  const resolvedSessionDataDir = path.join(resolvedUserDataDir, 'Session Data');
  fs.mkdirSync(resolvedSessionDataDir, { recursive: true });
  app.setPath('userData', resolvedUserDataDir);
  app.setPath('sessionData', resolvedSessionDataDir);
  log.info(`[Development] userData override: ${resolvedUserDataDir}`);
}

if (app.isPackaged) {
  // Packaged: read .env from the user-data folder (e.g. ~/Library/Application
  // Support/coco/.env). Bundling it via extraResources would ship the
  // builder's API keys inside every distributed app bundle.
  dotenv.config({ path: path.join(app.getPath('userData'), '.env') });
} else {
  // Dev: cwd is the desktop app dir, but the canonical .env (with GEMINI_API_KEY,
  // ANTHROPIC_API_KEY, etc.) lives at the repo root, one level up.
  // Load both — dotenv doesn't override pre-existing process.env entries, so
  // root-level keys win and desktop/.env supplies UI-only overrides.
  dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
  dotenv.config();
}

// Create default workspace directory if it doesn't exist
const ensureDefaultWorkspaceExists = () => {
  const workspaceDir = path.join(os.homedir(), 'coco', 'tmp_workspace');
  try {
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
      log.info(`Created default workspace directory: ${workspaceDir}`);
    }
  } catch (error) {
    log.error(`Failed to create default workspace directory: ${error}`);
  }
};

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

// ── Window state ─────────────────────────────────────────────────────────────
// avatarWindow      : always-on-top 150×150 pet/avatar (loads local index.html)
// chatWindow        : local tutor-chat side panel (loads index.html?view=session);
//                     created on demand, hidden (not destroyed) on close so the
//                     conversation survives a reopen. Talks only to the local
//                     tutor/sensing servers — no external backend or WebSocket.
// imagePreviewWindow: full-display preview for pending and sent chat images.
// sessionSetupWindow: small floating window for proactive session config
let avatarWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let imagePreviewWindow: BrowserWindow | null = null;
let imagePreviewDataUrl: string | null = null;
let notificationWindow: BrowserWindow | null = null;
let notificationHovered = false;
let latestHiddenSuggestionObservationId: string | undefined;
let onboardingWindow: BrowserWindow | null = null;
let sessionSetupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let hideAvatarMode = false;
let avatarRendererReady = false;
let pendingOpenHistory = false;
const observationSleepGuard = new ObservationSleepGuard();
let personalizationScheduler: PersonalizationScheduler | null = null;
let dailyMemoryDraftService: DailyMemoryDraftService | null = null;
let previewCocoSleepMode = false;

const isDailyMemoryPreviewOnly = () =>
  !app.isPackaged && process.env.COCO_DAILY_MEMORY_PREVIEW_ONLY === '1';

const isCocoSleeping = () =>
  personalizationScheduler?.isSleeping() ??
  (isDailyMemoryPreviewOnly() && previewCocoSleepMode);

const initializeDailyMemoryDraftService = () => {
  if (dailyMemoryDraftService) return;
  dailyMemoryDraftService = new DailyMemoryDraftService(
    app.getPath('userData'),
    path.join(app.getPath('userData'), 'personalization'),
    {
      fixtureStatePath: app.isPackaged
        ? undefined
        : process.env.COCO_DAILY_MEMORY_DRAFT_FIXTURE,
    },
  );
};

// Hot-key screen captures (Cmd/Ctrl+Shift+Space) waiting to be shown as preview
// thumbnails in the chat input bar. When the hot key opens a fresh chat window,
// the capture can arrive before the renderer has mounted its IPC listener, so we
// buffer here and flush once the renderer announces it is ready.
let pendingHotkeyCaptures: string[] = [];
let hotkeyRendererReady = false;

// Deliver any buffered hot-key captures to the chat renderer. No-op until the
// renderer has signalled readiness — that handshake is what makes delivery
// race-free regardless of whether the window was already open.
const flushHotkeyCaptures = () => {
  if (!hotkeyRendererReady) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;
  if (pendingHotkeyCaptures.length === 0) return;
  const toSend = pendingHotkeyCaptures;
  pendingHotkeyCaptures = [];
  toSend.forEach((imageDataUrl) => {
    chatWindow?.webContents.send('hotkey-capture', { imageDataUrl });
  });
};

// True once the Python services have been started. Guards against double-start
// and lets us defer startup until the user has chosen their models.
let observerStarted = false;
// isFloatMode: chat panel is in narrow side-panel mode (vs. expanded width).
let isFloatMode = true;
// Set true once the app is genuinely quitting so window 'close' handlers stop
// intercepting (they otherwise hide-instead-of-close, which would block quit).
let isQuitting = false;

// ── User profile ──────────────────────────────────────────────────────────────
const profilePath = () => path.join(app.getPath('userData'), 'coco-profile.json');

const isOnboardingComplete = (): boolean => {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf-8');
    const profile = JSON.parse(raw);
    return profile?.onboardingComplete === true;
  } catch {
    return false;
  }
};

const readHideAvatarSetting = (): boolean => {
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
    return profile?.hideAvatar === true;
  } catch {
    return false;
  }
};

// ── Proactive session state ───────────────────────────────────────────────────
let isSessionActive = false;
let currentUserId: string | null = null;
let currentSessionId: string | null = null;
let pendingTaskLabel: string | null = null;
let currentTutorModelId: string | null = null;
// Invite timing is owned by the sensing-side judge; no renderer-side cooldown.

const requestedPort = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
};

const canBindPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

const findAvailablePort = async (
  preferred: number,
  excluded: Set<number>,
): Promise<number> => {
  if (!excluded.has(preferred) && await canBindPort(preferred)) return preferred;
  for (let candidate = 49152; candidate <= 65535; candidate += 1) {
    if (!excluded.has(candidate) && await canBindPort(candidate)) return candidate;
  }
  throw new Error('Coco could not find an available local service port.');
};

const configureLocalServicePorts = async (): Promise<void> => {
  const requestedSensingPort = requestedPort(process.env.SENSING_PORT, 8080);
  const requestedTutorPort = requestedPort(process.env.TUTOR_PORT, 8081);
  const selected = new Set<number>();
  const sensingPort = await findAvailablePort(requestedSensingPort, selected);
  selected.add(sensingPort);
  const tutorPort = await findAvailablePort(requestedTutorPort, selected);

  process.env.SENSING_PORT = String(sensingPort);
  process.env.TUTOR_PORT = String(tutorPort);
  serviceManager.configureServiceArg('sensing-server', 'port', String(sensingPort));
  serviceManager.configureServiceArg('tutor-server', 'port', String(tutorPort));
  serviceManager.configureServiceArg(
    'sensing-server',
    'tutor_url',
    `http://127.0.0.1:${tutorPort}`,
  );
  const portEnv = {
    SENSING_PORT: String(sensingPort),
    TUTOR_PORT: String(tutorPort),
  };
  serviceManager.configureServiceEnv('sensing-server', portEnv);
  serviceManager.configureServiceEnv('tutor-server', portEnv);

  if (
    sensingPort !== requestedSensingPort ||
    tutorPort !== requestedTutorPort
  ) {
    log.warn(
      `[Ports] Requested sensing=${requestedSensingPort}, tutor=${requestedTutorPort}; ` +
      `using sensing=${sensingPort}, tutor=${tutorPort} because a port was occupied.`,
    );
  } else {
    log.info(`[Ports] sensing=${sensingPort}, tutor=${tutorPort}`);
  }
};

// Preload path helper
const preloadPath = () =>
  app.isPackaged
    ? path.join(__dirname, 'preload.js')
    : path.join(__dirname, '../../.erb/dll/preload.js');

// ── Onboarding window ─────────────────────────────────────────────────────────
// Shown once on first launch (when coco-profile.json doesn't exist yet).
// Centered modal; after the user completes or skips it, the profile is written
// and the normal avatar + webapp windows are created.

const createOnboardingWindow = (modelsOnly = false) => {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = 440;
  const h = 700;
  const x = Math.round((sw - w) / 2);
  const y = Math.round((sh - h) / 2);

  onboardingWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: w,
    height: h,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath() },
  });

  const url = `${resolveHtmlPath('index.html')}?view=onboarding${
    modelsOnly ? '&modelsOnly=1' : ''
  }`;
  onboardingWindow.loadURL(url);

  onboardingWindow.on('ready-to-show', () => {
    onboardingWindow?.show();
  });

  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
  });

  onboardingWindow.on('close', (event) => {
    if (isQuitting || (isOnboardingComplete() && readModelConfiguration())) {
      return;
    }
    event.preventDefault();
    onboardingWindow?.hide();
    createTray();
  });
};

// ── Avatar window ─────────────────────────────────────────────────────────────

const createAvatarWindow = () => {
  if (avatarWindow && !avatarWindow.isDestroyed()) return;
  avatarRendererReady = false;

  // Start small (just the pet). The renderer grows the window via
  // 'resize-avatar-window' when a bubble or the history panel becomes visible,
  // and shrinks it back when they go away. Keeps transparent dead-zones from
  // intercepting clicks meant for the desktop below.
  avatarWindow = new BrowserWindow({
    show: false,
    width: 180,
    height: 180,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath() },
  });

  avatarWindow.loadURL(resolveHtmlPath('index.html'));

  avatarWindow.on('ready-to-show', () => {
    if (hideAvatarMode) {
      avatarWindow?.hide();
    } else if (process.env.START_MINIMIZED) {
      avatarWindow?.minimize();
    } else {
      avatarWindow?.show();
    }
  });

  avatarWindow.on('closed', () => {
    avatarWindow = null;
    avatarRendererReady = false;
  });

  avatarWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // (notification is screen-pinned; no need to reposition on move)
};

// ── Chat window (local tutor session) ─────────────────────────────────────────
// A frameless right-edge side panel hosting the local SessionChatView. Unlike
// the old webapp window there is no WebSocket to keep alive, so it is created on
// demand and hidden (not destroyed) on close so the conversation persists if the
// user reopens it. All chat traffic goes straight to the local tutor server via
// the 'send-chat-message' IPC handler — no external backend involved.

const CHAT_PANEL_W = 420;
const CHAT_EXPANDED_W = 820;
const CHAT_CONTENT_ZOOM_LEVELS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let chatContentZoomFactor = 1;

const createChatWindow = () => {
  if (chatWindow && !chatWindow.isDestroyed()) return;

  // A fresh renderer hasn't mounted its hot-key listener yet; wait for its
  // readiness handshake before flushing any buffered captures.
  hotkeyRendererReady = false;

  chatWindow = new BrowserWindow({
    show: false,
    width: CHAT_PANEL_W,
    height: 700,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: preloadPath() },
  });

  chatWindow.loadURL(`${resolveHtmlPath('index.html')}?view=session`);

  const reportChatContentZoom = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return;
    chatWindow.webContents.send(
      'chat-content-zoom-factor',
      chatContentZoomFactor,
    );
  };
  chatWindow.webContents.setZoomFactor(1);
  void chatWindow.webContents.setVisualZoomLevelLimits(1, 1);
  chatWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.meta || input.control) &&
      ['+', '-', '=', '0'].includes(input.key)
    ) {
      event.preventDefault();
      const currentIndex = CHAT_CONTENT_ZOOM_LEVELS.reduce(
        (closest, level, index) =>
          Math.abs(level - chatContentZoomFactor) <
          Math.abs(CHAT_CONTENT_ZOOM_LEVELS[closest] - chatContentZoomFactor)
            ? index
            : closest,
        0,
      );
      if (input.key === '0') {
        chatContentZoomFactor = 1;
      } else if (input.key === '+' || input.key === '=') {
        chatContentZoomFactor = CHAT_CONTENT_ZOOM_LEVELS[
          Math.min(currentIndex + 1, CHAT_CONTENT_ZOOM_LEVELS.length - 1)
        ];
      } else {
        chatContentZoomFactor = CHAT_CONTENT_ZOOM_LEVELS[
          Math.max(currentIndex - 1, 0)
        ];
      }
      reportChatContentZoom();
    }
  });
  chatWindow.webContents.on('did-finish-load', () => {
    chatWindow?.webContents.setZoomFactor(1);
    reportChatContentZoom();
  });

  // Closing hides rather than destroys so the in-memory conversation survives a
  // reopen; the avatar always comes back to the foreground. On a real app quit
  // (isQuitting) we let the window close so shutdown isn't blocked.
  chatWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    chatWindow?.hide();
    if (hideAvatarMode) return;
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      createAvatarWindow();
    } else {
      avatarWindow.show();
    }
  });

  chatWindow.on('closed', () => { chatWindow = null; });

  chatWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

// Position the chat window as a right-edge side panel and show it.
const showChatPanel = () => {
  createChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;

  const disp = screen.getDisplayMatching(chatWindow.getBounds());
  const { x: dx, y: dy, width: sw, height: sh } = disp.workArea;
  const w = isFloatMode ? CHAT_PANEL_W : CHAT_EXPANDED_W;
  const h = Math.min(760, sh - 32);

  chatWindow.setSize(w, h);
  chatWindow.setPosition(dx + sw - w - 16, dy + Math.floor((sh - h) / 2));
  chatWindow.setAlwaysOnTop(true, 'floating');
  chatWindow.show();
  chatWindow.focus();
  // The avatar stays visible alongside the chat panel — never hide it, so the
  // pet is always available and closing the chat can't leave a blank screen.
  if (
    !hideAvatarMode &&
    avatarWindow &&
    !avatarWindow.isDestroyed() &&
    !avatarWindow.isVisible()
  ) {
    avatarWindow.show();
  }
};

const openImagePreviewWindow = (
  sourceWindow: BrowserWindow | null,
  imageDataUrl: string,
) => {
  imagePreviewDataUrl = imageDataUrl;
  const display = sourceWindow
    ? screen.getDisplayMatching(sourceWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
    imagePreviewWindow.setBounds(display.bounds);
    if (!imagePreviewWindow.webContents.isLoadingMainFrame()) {
      imagePreviewWindow.webContents.send('image-preview', { imageDataUrl });
      imagePreviewWindow.show();
      imagePreviewWindow.focus();
    }
    return;
  }

  imagePreviewWindow = new BrowserWindow({
    show: false,
    ...display.bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#111827',
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  });
  imagePreviewWindow.setAlwaysOnTop(true, 'floating');
  imagePreviewWindow.loadURL(
    `${resolveHtmlPath('index.html')}?view=image-preview`,
  );
  imagePreviewWindow.on('closed', () => {
    imagePreviewWindow = null;
    imagePreviewDataUrl = null;
  });
};

const openChatSettings = () => {
  createChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;

  showChatPanel();
  const revealSettings = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return;
    chatWindow.webContents.send('open-chat-settings');
  };
  if (chatWindow.webContents.isLoadingMainFrame()) {
    chatWindow.webContents.once('did-finish-load', revealSettings);
  } else {
    revealSettings();
  }
};

ipcMain.removeAllListeners('open-chat-settings');
ipcMain.on('open-chat-settings', () => openChatSettings());

async function openCoco(): Promise<void> {
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '');
    return;
  }
  const problemStatement = pendingTaskLabel || 'General help session';
  await createProactiveTutorSession(problemStatement, 120);
}

function setupPending(): boolean {
  return !isOnboardingComplete() || !readModelConfiguration();
}

function openPrimaryTrayAction(): void {
  if (setupPending()) {
    if (!onboardingWindow || onboardingWindow.isDestroyed()) {
      createOnboardingWindow(isOnboardingComplete());
    } else {
      onboardingWindow.show();
      onboardingWindow.focus();
    }
    return;
  }
  openCoco().catch((err) => log.warn(`[Tray] Could not open Coco: ${err}`));
}

function handleTrayClick(): void {
  // Preserve the setup-window recovery path, but once setup is complete let
  // the user choose an explicit action instead of opening chat immediately.
  if (setupPending()) {
    openPrimaryTrayAction();
    return;
  }
  tray?.popUpContextMenu();
}

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(__dirname, '../../assets/icon.png');
}

function createTray(): void {
  if (!tray || tray.isDestroyed()) {
    const image = nativeImage.createFromPath(trayIconPath()).resize({
      width: 22,
      height: 22,
    });
    tray = new Tray(image);
    tray.on('click', handleTrayClick);
  }
  const pendingSetup = setupPending();
  const sleeping = isCocoSleeping();
  tray.setToolTip(
    pendingSetup ? 'Coco' : `Coco — ${sleeping ? 'Sleeping' : 'Awake'}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate(pendingSetup ? [
      {
        label: isOnboardingComplete() ? 'Open Model Setup' : 'Continue Setup',
        click: openPrimaryTrayAction,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ] : [
      {
        label: sleeping ? 'Status: Sleeping' : 'Status: Awake',
        enabled: false,
      },
      {
        label: sleeping ? 'Wake Coco' : 'Put Coco to Sleep',
        click: () => {
          // Function declaration is intentionally below the tray setup.
          // eslint-disable-next-line no-use-before-define
          setCocoSleepMode(!sleeping).catch((err) =>
            log.warn(`[Tray] Could not change sleep mode: ${err}`),
          );
        },
      },
      { type: 'separator' },
      {
        label: 'Open Chat',
        click: openPrimaryTrayAction,
      },
      {
        label: 'Open History',
        click: () => {
          openHistory();
        },
      },
      {
        label: 'Settings…',
        click: () => {
          openChatSettings();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function openHistory(): void {
  pendingOpenHistory = true;
  if (!avatarWindow || avatarWindow.isDestroyed()) createAvatarWindow();
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (!avatarRendererReady) return;
  pendingOpenHistory = false;
  avatarWindow.show();
  avatarWindow.webContents.send('open-observation-history');
}

function applyAvatarVisibility(hidden: boolean): void {
  hideAvatarMode = hidden;
  if (hidden) {
    avatarWindow?.hide();
    createTray();
    return;
  }
  tray?.destroy();
  tray = null;
  createAvatarWindow();
  avatarWindow?.show();
}

interface ChatSeed {
  phrase: string;
  label: string;
  rawObservation: string;
  /** Attach context to the user's next turn instead of sending immediately. */
  deferUntilUserMessage?: boolean;
  /** Pre-fill Coco's composer without sending the message. */
  initialInput?: string;
}

// Open the chat panel for a session, pushing the session context (and an
// optional observation to send now or attach to the user's next message).
const openChatForSession = (
  sessionId: string,
  problemStatement: string,
  seed?: ChatSeed,
) => {
  const alreadyLoaded = chatWindow && !chatWindow.isDestroyed();
  isFloatMode = true;
  showChatPanel();
  if (!chatWindow) return;

  const send = () => {
    chatWindow?.webContents.send('session-init', {
      sessionId,
      problemStatement,
      tutorModelId: currentTutorModelId,
    });
    if (seed) chatWindow?.webContents.send('help-request', seed);
  };
  if (alreadyLoaded) {
    send();
  } else {
    chatWindow.webContents.once('did-finish-load', () => setTimeout(send, 300));
  }
};

// ── Session-setup floating window ────────────────────────────────────────────
// Small always-on-top panel shown after the user accepts a proactive "start
// a session?" prompt.  Lets them pick a model and struggle-check interval.

const showSessionSetupWindow = async (taskLabel: string | null) => {
  sessionSetupWindow?.destroy();

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = 340;
  const h = 280; // editable task description textarea + struggle interval
  const x = sw - w - 16;
  const y = sh - h - 16;

  sessionSetupWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: w,
    height: h,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath() },
  });

  const url = `${resolveHtmlPath('index.html')}?view=session-setup`;
  sessionSetupWindow.loadURL(url);

  sessionSetupWindow.on('ready-to-show', () => {
    sessionSetupWindow?.show();
    sessionSetupWindow?.webContents.send('session-setup-init', { taskLabel });
  });

  sessionSetupWindow.on('closed', () => { sessionSetupWindow = null; });
};

// ── Notification bubble window ────────────────────────────────────────────────
// Notification is pinned to the top-right corner of the primary display so it
// is always fully visible and never clipped by the app window edge.

const NOTIF_WIDTH = 360;
// Keep the card compact; longer Markdown guidance scrolls inside the body.
const NOTIF_HEIGHT = 220;
const NOTIF_EXPANDED_WIDTH = 560;
const NOTIF_EXPANDED_HEIGHT = 520;

type VizState = 'none' | 'success' | 'error';
type NotifType =
  | 'default'
  | 'proactive-suggestion'
  | 'instant-suggestion'
  | 'session-start-prompt'
  | 'session-end-prompt';

const showNotification = (payload: {
  message: string;
  actionLabel: string;
  vizState?: VizState;
  notifType?: NotifType;
  cancelLabel?: string;
  observationId?: string;
  status?: string;
  rawObservation?: string;
  suggestion?: InstantSuggestion;
}) => {
  if (payload.notifType !== 'proactive-suggestion') {
    latestHiddenSuggestionObservationId = undefined;
  }
  if (
    notificationHovered &&
    notificationWindow &&
    !notificationWindow.isDestroyed()
  ) {
    log.info('[Notification] Keeping hovered notification; dropping replacement.');
    return;
  }
  // Destroy any existing notification before showing a new one (dedup guard).
  notificationHovered = false;
  notificationWindow?.destroy();

  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - NOTIF_WIDTH - 16;
  const y = workArea.y + 16;
  const adjustable = hideAvatarMode;

  notificationWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: adjustable,
    minimizable: false,
    maximizable: false,
    minWidth: adjustable ? 320 : undefined,
    minHeight: adjustable ? 180 : undefined,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath() },
  });

  const url = `${resolveHtmlPath('index.html')}?view=notification`;
  notificationWindow.loadURL(url);

  notificationWindow.on('ready-to-show', () => {
    notificationWindow?.show();
    notificationWindow?.webContents.send('notification', {
      ...payload,
      adjustable,
    });
  });

  notificationWindow.on('closed', () => {
    notificationWindow = null;
    notificationHovered = false;
  });
};

// ── IPC handlers ──────────────────────────────────────────────────────────────
// Use removeAllListeners before each .on() so hot-reloads in development never
// accumulate duplicate handlers (which would fire multiple notifications).

// ── Onboarding ────────────────────────────────────────────────────────────────

// Returns the saved onboarding profile so renderer/webapp code can read it
// without needing filesystem access. Returns null if the profile doesn't exist.
ipcMain.handle('get-profile', () => {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('get-chat-content-zoom-factor', () => chatContentZoomFactor);

// Model/provider configuration is owned by the main process. The renderer sees
// only masked credential status; plaintext keys are accepted on save and never
// returned over IPC.
ipcMain.handle('get-model-configuration', () => getModelConfigurationView());

type ModelHealthAssessment = {
  status:
    | 'verified'
    | 'failed'
    | 'legacy_unassessed'
    | 'not_configured';
  detail: string;
};
const modelHealthCache = new Map<
  string,
  { checkedAt: number; assessment: ModelHealthAssessment }
>();
const modelHealthInFlight = new Map<string, Promise<ModelHealthAssessment>>();
const MODEL_HEALTH_CACHE_MS = 30 * 60 * 1000;

ipcMain.handle(
  'get-service-health',
  async (
    _event,
    { forceModelTest = false }: { forceModelTest?: boolean } = {},
  ) => {
  type ModelAssessment = {
    status: ModelHealthAssessment['status'];
    detail: string;
  };
  const savedConfig = readModelConfiguration();
  const assessModelConfiguration = async (
    role: 'sensing' | 'tutor',
  ): Promise<ModelAssessment> => {
    const connection = role === 'sensing'
      ? savedConfig?.sensing
      : savedConfig?.tutors.find((item) => item.id === currentTutorModelId) ??
        savedConfig?.tutors.find((item) => item.id === savedConfig.defaultTutorId);
    if (connection) {
      const cacheKey = `${role}:${JSON.stringify(connection)}`;
      const cached = modelHealthCache.get(cacheKey);
      if (
        !forceModelTest &&
        cached &&
        Date.now() - cached.checkedAt < MODEL_HEALTH_CACHE_MS
      ) {
        return cached.assessment;
      }
      const existingTest = modelHealthInFlight.get(cacheKey);
      if (existingTest) return existingTest;
      const test = (async (): Promise<ModelHealthAssessment> => {
        const result = await testModelConnection(null, { role, connection });
        const assessment: ModelHealthAssessment = result.success
          ? {
              status: 'verified',
              detail: result.message || 'Model connection verified.',
            }
          : {
              status: 'failed',
              detail: result.error || 'The model connection test failed.',
            };
        modelHealthCache.set(cacheKey, { checkedAt: Date.now(), assessment });
        return assessment;
      })();
      modelHealthInFlight.set(cacheKey, test);
      try {
        return await test;
      } finally {
        modelHealthInFlight.delete(cacheKey);
      }
    }
    const legacyModel = role === 'sensing'
      ? process.env.OBSERVER_MODEL
      : process.env.TUTOR_MODEL;
    if (legacyModel?.trim()) {
      return {
        status: 'legacy_unassessed',
        detail: 'Model uses environment settings and cannot be assessed here.',
      };
    }
    return {
      status: 'not_configured',
      detail: 'No model configuration was found.',
    };
  };

  const checkService = async (
    url: string,
    expectedService: 'coco-sensing' | 'coco-tutor',
    modelAssessment: ModelAssessment,
  ) => {
    try {
      const response = await axios.get(url, { timeout: 2500 });
      const data = response.data as {
        status?: unknown;
        service?: unknown;
        total_actions?: unknown;
      };
      if (data?.service !== expectedService) {
        return {
          connected: false,
          status: 'wrong-service',
          detail: 'This port is occupied by another process.',
          modelAssessment,
        };
      }
      return {
        connected: true,
        status: typeof data?.status === 'string' ? data.status : 'healthy',
        modelAssessment,
        ...(typeof data?.total_actions === 'number'
          ? { totalActions: data.total_actions }
          : {}),
      };
    } catch (error) {
      let detail = 'Service is not reachable.';
      if (axios.isAxiosError(error)) {
        const responseData = error.response?.data as
          | { detail?: unknown }
          | undefined;
        if (
          typeof responseData?.detail === 'string' &&
          responseData.detail.trim()
        ) {
          detail = responseData.detail;
        } else if (error.code === 'ECONNREFUSED') {
          detail = 'Service is not running.';
        } else if (error.code === 'ECONNABORTED') {
          detail = 'Health check timed out.';
        } else if (error.message) {
          detail = error.message;
        }
      } else if (error instanceof Error) {
        detail = error.message;
      }
      return {
        connected: false,
        status: 'unavailable',
        detail,
        modelAssessment,
      };
    }
  };

  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const [sensingAssessment, tutorAssessment] = await Promise.all([
    assessModelConfiguration('sensing'),
    assessModelConfiguration('tutor'),
  ]);
  const [sensing, tutor] = await Promise.all([
    checkService(
      `http://127.0.0.1:${sensingPort}/health`,
      'coco-sensing',
      sensingAssessment,
    ),
    checkService(
      `http://127.0.0.1:${tutorPort}/health`,
      'coco-tutor',
      tutorAssessment,
    ),
  ]);

  return { checkedAt: Date.now(), sensing, tutor };
  },
);

async function testModelConnection(
    _event: unknown,
    {
      role,
      connection,
      apiKey,
    }: {
      role?: 'sensing' | 'tutor';
      connection?: ModelConnection;
      apiKey?: string;
    } = {},
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    if ((role !== 'sensing' && role !== 'tutor') || !connection) {
      return { success: false, error: 'Invalid model test request.' };
    }
    try {
      const prepared = prepareModelConnectionTest(
        connection,
        role,
        apiKey ?? '',
      );
      const providerEnvNames = new Set([
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'OPENAI_API_KEY',
        'TINFOIL_API_KEY',
        'HOSTED_VLLM_API_KEY',
        'HOSTED_VLLM_API_BASE',
        'LM_STUDIO_HOST',
        'OA_TICKET_FILE',
        'OA_DESTINATION',
        'OA_BASE_URL',
      ]);
      const childEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !providerEnvNames.has(name),
          ),
        ),
        ...prepared.env,
        PYTHONIOENCODING: 'utf-8',
      };
      const executable = app.isPackaged
        ? path.join(
            process.resourcesPath,
            'service-dist',
            'coco-services',
            `tutor-server${process.platform === 'win32' ? '.exe' : ''}`,
          )
        : 'uv';
      const args = app.isPackaged
        ? [
            '--test-model-connection',
            '--model',
            prepared.connection.model,
            ...(role === 'sensing' ? ['--include-image'] : []),
          ]
        : [
            'run',
            'python',
            '-m',
            'proactive_tutor.model_connection_test',
            '--model',
            prepared.connection.model,
            ...(role === 'sensing' ? ['--include-image'] : []),
          ];
      const cwd = app.isPackaged
        ? path.dirname(executable)
        : path.resolve(process.cwd(), '..');
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(executable, args, {
          cwd,
          env: childEnv,
          shell: false,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Connection test timed out after 60 seconds.'));
        }, 60_000);
        child.stdout?.on('data', (chunk) => {
          stdout = `${stdout}${String(chunk)}`.slice(-32_000);
        });
        child.stderr?.on('data', (chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-32_000);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
      const parsed = result.stdout
        .trim()
        .split('\n')
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line) as { success?: boolean; error?: string };
          } catch {
            return null;
          }
        })
        .find((item) => item !== null);
      if (result.code === 0 && parsed?.success) {
        return {
          success: true,
          message:
            role === 'sensing'
              ? 'Connected — text and image input accepted.'
              : 'Connected — text input accepted.',
        };
      }
      const rawError = parsed?.error || result.stderr.trim() || 'Connection failed.';
      const redactedError = apiKey
        ? rawError.split(apiKey).join('[redacted]')
        : rawError;
      return { success: false, error: redactedError };
    } catch (err) {
      const rawError = (err as Error).message;
      return {
        success: false,
        error: apiKey ? rawError.split(apiKey).join('[redacted]') : rawError,
      };
    }
  }

ipcMain.handle('test-model-connection', testModelConnection);

async function restoreSessionAfterModelRestart(): Promise<void> {
  if (!currentSessionId) return;
  const conversation = readConversations().find(
    (item) => item.sessionId === currentSessionId,
  );
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const sensing = `http://127.0.0.1:${sensingPort}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await Promise.all([
        axios.get(`${tutor}/health`, { timeout: 1000 }),
        axios.get(`${sensing}/health`, { timeout: 1000 }),
      ]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const { aiTools, scenario, customObserverPrompt } = readProfile();
  await axios.post(`${tutor}/config/scenario`, { scenario }, { timeout: 8000 });
  await axios.post(
    `${tutor}/context/problem_statement`,
    { problem_statement: conversation?.problem || pendingTaskLabel || '' },
    { timeout: 8000 },
  );
  await axios.post(
    `${tutor}/context/ai_tools`,
    { ai_tools: aiTools },
    { timeout: 8000 },
  );
  const memory = readLocalMemory();
  if (memory) {
    await axios.post(`${tutor}/context/memory`, { memory }, { timeout: 8000 });
  }
  if (conversation) {
    await axios.post(
      `${tutor}/context/conversation`,
      {
        messages: conversation.messages
          .filter((message) => !message.isError)
          .map(({ role, text }) => ({ role, text })),
      },
      { timeout: 8000 },
    );
  }
  await axios.post(
    `${sensing}/session`,
    {
      node_uuid: currentSessionId,
      struggle_detection_seconds: 120,
      scenario,
      config_source: 'model_settings_restart',
      ...(customObserverPrompt && {
        custom_observer_prompt: customObserverPrompt,
      }),
    },
    { timeout: 15000 },
  );
}

ipcMain.handle(
  'save-model-configuration',
  async (_event, input: ModelConfigurationInput) => {
    try {
      const config = saveModelConfiguration(input);
      modelHealthCache.clear();
      const runtime = resolveModelRuntime();
      if (observerStarted && runtime) {
        const defaultTutorModel = defaultTutor(runtime.config);
        const activeTutorModel =
          runtime.config.tutors.find(
            (item) => item.id === currentTutorModelId,
          ) ?? defaultTutorModel;
        currentTutorModelId = activeTutorModel.id;
        process.env.TUTOR_MODEL = defaultTutorModel.model;
        process.env.OBSERVER_MODEL = runtime.config.sensing.model;
        await Promise.all([
          serviceManager.stopService('tutor-server'),
          serviceManager.stopService('sensing-server'),
        ]);
        serviceManager.configureServiceEnv(
          'tutor-server',
          runtime.tutorEnv,
          true,
        );
        serviceManager.configureServiceEnv(
          'sensing-server',
          runtime.sensingEnv,
          true,
        );
        serviceManager.configureServiceArg(
          'tutor-server',
          'model_name',
          activeTutorModel.model,
        );
        serviceManager.configureServiceArg(
          'sensing-server',
          'observer_model',
          runtime.config.sensing.model,
        );
        serviceManager.startService('tutor-server');
        serviceManager.startService('sensing-server');
        try {
          await restoreSessionAfterModelRestart();
        } catch (err) {
          log.warn(
            `[Models] Services restarted but active session restoration failed: ${(err as Error).message}`,
          );
        }
      }
      return { success: true, config };
    } catch (err) {
      log.warn(`[Models] Could not save configuration: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'set-chat-model',
  async (_event, { modelId }: { modelId?: string } = {}) => {
    const config = readModelConfiguration();
    const selected = config?.tutors.find((item) => item.id === modelId);
    if (!selected) return { success: false, error: 'Tutor model not found.' };
    const tutorPort = process.env.TUTOR_PORT || '8081';
    try {
      await axios.post(
        `http://127.0.0.1:${tutorPort}/config/model`,
        { model: selected.model },
        { timeout: 8000 },
      );
      currentTutorModelId = selected.id;
      return { success: true, modelId: selected.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
);

// Persist profile edits made post-onboarding (the Settings surface in the
// webapp).
ipcMain.handle('save-profile', (_event, profile: object) => {
  try {
    fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
    log.info('[Settings] Profile saved:', profilePath());
    return { success: true };
  } catch (err) {
    log.error('[Settings] Failed to save profile:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.on('onboarding-complete', (_event, profile: object) => {
  // Write the profile so isOnboardingComplete() returns true on next launch.
  try {
    fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
    log.info('[Onboarding] Profile saved:', profilePath());
  } catch (err) {
    log.error('[Onboarding] Failed to save profile:', err);
  }

  // Start the observer now that the user has completed or skipped onboarding.
  startObserver();

  // Onboarding window closes itself (window.close() in renderer). Start the
  // avatar now that setup is complete; the chat panel is created on demand.
  applyAvatarVisibility(readHideAvatarSetting());
});

ipcMain.removeAllListeners('hide-onboarding');
ipcMain.on('hide-onboarding', () => {
  onboardingWindow?.hide();
  createTray();
});

ipcMain.removeAllListeners('model-configuration-complete');
ipcMain.on('model-configuration-complete', () => {
  // Existing users sent directly to model setup already have a profile. Once
  // models are saved, start (or restart) the services and reveal the app
  // without making them repeat the rest of onboarding.
  startObserver();
  applyAvatarVisibility(readHideAvatarSetting());
});

// The chat renderer announces (on mount) that its hot-key-capture listener is
// live. Flush any captures that arrived before it was ready — this handshake is
// what lets the hot key open the chat AND attach the screenshot reliably.
ipcMain.removeAllListeners('hotkey-capture-ready');
ipcMain.on('hotkey-capture-ready', () => {
  hotkeyRendererReady = true;
  flushHotkeyCaptures();
});

// Pet click / "open chat". If a session is already active, reopen its chat
// panel; otherwise start a fresh local session so there is a conversation to
// show (the sensing observer keeps running either way).
ipcMain.removeAllListeners('open-main-window');
ipcMain.on('open-main-window', () => {
  openCoco().catch((err) => log.warn(`[Chat] Could not open Coco: ${err}`));
});

// "Help me with this" on a proactive bubble.
//   • Active session  → open the chat panel and inject the observation as a new
//     message into the existing conversation.
//   • No active session → this IS accepting the invite: create a tutor session
//     seeded with what the user was doing, then inject the observation as the
//     first message once the chat panel has loaded.
ipcMain.removeAllListeners('help-me-with-this');
ipcMain.on('help-me-with-this', async (_event, payload: { phrase: string; label: string; rawObservation: string }) => {
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '', payload);
    return;
  }

  // Pre-session: create a session, then inject the observation once it loads.
  const problemStatement =
    payload?.phrase?.trim() || payload?.label?.trim() || pendingTaskLabel || 'General help session';
  const sessionId = await createProactiveTutorSession(problemStatement, 120, payload);
  if (!sessionId) {
    log.warn('[Chat] Could not start a local tutor session for help-me-with-this.');
  }
});

ipcMain.removeAllListeners('open-notification-suggestion');
ipcMain.on(
  'open-notification-suggestion',
  async (
    _event,
    payload: {
      observationId?: string;
      status?: string;
      rawObservation?: string;
    },
  ) => {
    notificationWindow?.destroy();
    const rawObservation = payload?.rawObservation?.trim() || '';
    const status = payload?.status || 'observing';
    const observationId = payload?.observationId;
    const seed = {
      phrase: rawObservation,
      label: status.replace(/_/g, ' '),
      rawObservation,
    };

    if (observationId) {
      recordSupportEngagement(observationId, {
        engagedAt: Math.floor(Date.now() / 1000),
        destination: 'conversation',
      });
    }
    const sensingPort = process.env.SENSING_PORT || '8080';
    axios.post(
      `http://127.0.0.1:${sensingPort}/feedback`,
      {
        kind: 'engage',
        surface: 'notification',
        observation_id: observationId ?? null,
        status,
        text: rawObservation,
      },
      { timeout: 3000 },
    )
      .catch((err) => {
        log.warn(`[Feedback] failed to post: ${(err as Error).message}`);
      })
      .finally(() => personalizationScheduler?.noteFeedback());

    if (isSessionActive && currentSessionId) {
      openChatForSession(currentSessionId, pendingTaskLabel || '', seed);
    } else {
      await createProactiveTutorSession(
        rawObservation || 'General help session',
        120,
        seed,
      );
    }
  },
);

// Forward an explicit user reaction (bubble engage/dismiss) to the sensing
// server's /feedback endpoint, which logs it into the shared training data.
ipcMain.removeAllListeners('training-feedback');
ipcMain.on('training-feedback', async (_event, payload) => {
  try {
    const sensingPort = process.env.SENSING_PORT || '8080';
    await axios.post(
      `http://127.0.0.1:${sensingPort}/feedback`,
      payload ?? {},
      { timeout: 3000 },
    );
  } catch (err) {
    log.warn(
      `[Feedback] failed to post: ${(err as { message?: string })?.message}`,
    );
  } finally {
    personalizationScheduler?.noteFeedback();
  }
});

ipcMain.removeHandler('get-coco-sleep-mode');
ipcMain.handle('get-coco-sleep-mode', () => ({
  sleeping: isCocoSleeping(),
}));

async function setCocoSleepMode(sleeping: boolean) {
  if (!personalizationScheduler && !isDailyMemoryPreviewOnly()) {
    return { success: false, error: 'Personalization is not ready.' };
  }
  if (sleeping && personalizationScheduler) {
    if (isSessionActive) endCurrentSession();
    await Promise.all([
      serviceManager.stopService('sensing-server'),
      serviceManager.stopService('tutor-server'),
    ]);
    personalizationScheduler.setSleepMode(true);
  } else if (personalizationScheduler) {
    personalizationScheduler.setSleepMode(false);
    serviceManager.startAll();
  }
  previewCocoSleepMode = sleeping;
  avatarWindow?.webContents.send('coco-sleep-mode-changed', { sleeping });
  if (!sleeping) {
    avatarWindow?.webContents.send('daily-memory-draft-refresh');
  }
  if (tray && !tray.isDestroyed()) createTray();
  return { success: true, sleeping };
}

ipcMain.removeHandler('set-coco-sleep-mode');
ipcMain.handle(
  'set-coco-sleep-mode',
  async (_event, { sleeping }: { sleeping?: boolean } = {}) => {
    if (typeof sleeping !== 'boolean') {
      return { success: false, error: 'Invalid sleep mode.' };
    }
    return setCocoSleepMode(sleeping);
  },
);

ipcMain.removeAllListeners('notification');
ipcMain.on('notification', (_event, args) => {
  const { msg, buttonText } = args;
  showNotification({
    message: msg,
    actionLabel: buttonText,
  });
});

ipcMain.removeAllListeners('notification-hover-state');
ipcMain.on(
  'notification-hover-state',
  (_event, { hovered }: { hovered?: boolean }) => {
    notificationHovered = hovered === true;
  },
);

ipcMain.removeAllListeners('set-notification-expanded');
ipcMain.on(
  'set-notification-expanded',
  (_event, { expanded }: { expanded?: boolean }) => {
    if (
      !hideAvatarMode ||
      !notificationWindow ||
      notificationWindow.isDestroyed()
    ) {
      return;
    }

    const current = notificationWindow.getBounds();
    const display = screen.getDisplayMatching(current);
    const targetWidth = expanded ? NOTIF_EXPANDED_WIDTH : NOTIF_WIDTH;
    const targetHeight = expanded ? NOTIF_EXPANDED_HEIGHT : NOTIF_HEIGHT;
    const width = Math.min(targetWidth, display.workArea.width);
    const height = Math.min(targetHeight, display.workArea.height);

    // Preserve a user-dragged position where possible, while ensuring the
    // resized notification remains fully reachable on its current display.
    const x = Math.max(
      display.workArea.x,
      Math.min(current.x, display.workArea.x + display.workArea.width - width),
    );
    const y = Math.max(
      display.workArea.y,
      Math.min(
        current.y,
        display.workArea.y + display.workArea.height - height,
      ),
    );
    notificationWindow.setBounds({ x, y, width, height }, true);
  },
);

// ── Chat-panel width toggle ────────────────────────────────────────────────────
// The renderer sends this when the user clicks the expand / collapse button to
// switch the chat between the narrow side panel and a wider reading width.
ipcMain.removeAllListeners('toggle-float-window');
ipcMain.on('toggle-float-window', () => {
  if (!chatWindow || chatWindow.isDestroyed()) return;
  isFloatMode = !isFloatMode; // isFloatMode === narrow side-panel
  showChatPanel();
  chatWindow.webContents.send('float-window-state', { isFloat: isFloatMode });
});

ipcMain.on('shell-show-item-in-finder', (event, fullPath) => {
  shell.showItemInFolder(fullPath);
});

// ── Dynamic avatar-window resize ──────────────────────────────────────────────
// Renderer asks for a new content size when the bubble or history panel
// appears/disappears. We pin the bottom-right corner so the pet stays put
// while the window grows up and to the left.
ipcMain.removeAllListeners('resize-avatar-window');
ipcMain.on(
  'resize-avatar-window',
  (_event, { width, height }: { width: number; height: number }) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const b = avatarWindow.getBounds();
    if (b.width === w && b.height === h) return;
    avatarWindow.setBounds({
      x: b.x + b.width - w,
      y: b.y + b.height - h,
      width: w,
      height: h,
    });
  },
);

ipcMain.removeAllListeners('activity-history-visibility');
ipcMain.on(
  'activity-history-visibility',
  (_event, { visible }: { visible?: boolean }) => {
    if (!hideAvatarMode) return;
    if (visible === true) avatarWindow?.show();
    else if (visible === false) avatarWindow?.hide();
  },
);

ipcMain.removeAllListeners('avatar-renderer-ready');
ipcMain.on('avatar-renderer-ready', () => {
  avatarRendererReady = true;
  if (pendingOpenHistory) openHistory();
});

// ── Proactive session IPC handlers ────────────────────────────────────────────

// Webapp signals that a tutor session is now active (or has ended).
// Payload: { active: boolean; sessionId?: string }
ipcMain.removeAllListeners('session-active');
ipcMain.on('session-active', (_event, payload: { active: boolean; sessionId?: string }) => {
  isSessionActive = payload.active;
  if (payload.active && payload.sessionId) {
    currentSessionId = payload.sessionId;
    // Dismiss the onboarding overlay if still open — a live session takes over.
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.destroy();
      onboardingWindow = null;
    }
  }
  if (!payload.active) {
    currentSessionId = null;
    // Tell sensing server to revert to pre-session observation mode.
    const sensingPort = process.env.SENSING_PORT || '8080';
    axios
      .post(`http://127.0.0.1:${sensingPort}/session/end`)
      .catch((e) => log.warn('Could not notify sensing server of session end:', e));
  }
  log.info(`[ProactiveSession] isSessionActive=${payload.active}, sessionId=${payload.sessionId}`);
});

// User clicked "Yes" in the "start a session?" notification.
// Main shows the mini session-setup window.
ipcMain.removeAllListeners('show-session-setup');
ipcMain.on('show-session-setup', () => {
  notificationWindow?.destroy();
  showSessionSetupWindow(pendingTaskLabel);
});

// Read the user's onboarding profile for the AI tools and tutor mode they
// selected. Returns sensible defaults when the file is missing or malformed.
// Shared by createProactiveTutorSession() and the instant-suggestion precompute.
function readProfile(): {
  aiTools: string[];
  scenario: string;
  customObserverPrompt: string;
  userName: string;
} {
  let aiTools: string[] = [];
  let scenario = 'everyday_support';
  let customObserverPrompt = '';
  let userName = '';
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
    if (typeof profile.tutorScenario === 'string' && profile.tutorScenario) {
      scenario = profile.tutorScenario;
    }
    if (Array.isArray(profile.aiTools) && profile.aiTools.length > 0) {
      aiTools = profile.aiTools;
    }
    if (typeof profile.customSystemPrompt === 'string' && profile.customSystemPrompt.trim()) {
      customObserverPrompt = profile.customSystemPrompt;
    }
    if (typeof profile.userName === 'string' && profile.userName.trim()) {
      userName = profile.userName.trim();
    }
    // "Custom" mode customizes only the sensing observer prompt. The judge/tutor
    // still run on a real base scenario, so map 'custom' → 'everyday_support'.
    if (scenario === 'custom') {
      scenario = 'everyday_support';
    }
  } catch (err) {
    log.warn(`[Profile] Could not read profile at ${profilePath()}: ${err}.`);
  }
  return { aiTools, scenario, customObserverPrompt, userName };
}

// ── Instant suggestion precompute cache ─────────────────────────────────────
// When a Tier-2 proactive bubble appears we eagerly ask the tutor server for a
// ready-to-use suggestion and cache the in-flight promise keyed by
// observation_id. By the time the user clicks "Help me with this" (a few
// seconds of reading later) the result is usually ready, so it can be revealed
// instantly instead of waiting on a fresh LLM round-trip.
interface InstantSuggestion {
  kind: 'content' | 'delegate';
  title: string;
  body?: string;
  targetTool?: string;
  prompt?: string;
  copyText: string;
  availableTools?: AiToolButton[];
  llm_metrics?: LLMCallMetrics;
}

const suggestionCache = new Map<string, { ts: number; promise: Promise<InstantSuggestion | null> }>();
const SUGGESTION_TTL_MS = 5 * 60_000;
// Model latency can exceed 12 seconds under load. Keep the eager request alive
// long enough for the notification click to reveal its result instead of
// incorrectly treating a slow generation as a cache failure and opening Chat.
const SUGGESTION_REQUEST_TIMEOUT_MS = 60_000;
// Monotonic counter for synthesizing observation ids on events that lack one.
let syntheticObsSeq = 0;
// Statuses that show a "Help me with this" button (mirrors the renderer's
// TIER2_STATUSES in App.tsx). Only these warrant a precompute.
const PRECOMPUTE_STATUSES = new Set([
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'support_needed',
  'discernment_opportunity',
]);
// Build the list of Open buttons for a delegate suggestion from the user's
// selected tools. The model's chosen tool (`preferredId`) implies whether the
// task calls for a chatbot or an agent, so we show ONLY the user's tools in
// that category (recommended tool first) and let them pick among them. Falls
// back to all their tools — then ChatGPT — if that category has none.
function buildAvailableTools(preferredId?: string | null): AiToolButton[] {
  const { aiTools } = readProfile();
  const resolved = resolveAiTools(aiTools, preferredId);
  const category = preferredId ? parseAiTool(preferredId)?.category : undefined;
  const sameCategory = category
    ? resolved.filter((t) => t.category === category)
    : resolved;
  const list =
    sameCategory.length > 0
      ? sameCategory
      : resolved.length > 0
        ? resolved
        : [AI_TOOLS.chatgpt];
  return list.map((t) => ({ id: t.id, label: t.label, category: t.category }));
}

// Launch a tool per its category/open method. The prompt is already on the
// clipboard; the user pastes it manually (we never auto-run anything).
function openAiTool(toolId: string): void {
  const tool = parseAiTool(toolId);
  if (!tool) return;
  const { open } = tool;
  if (open.via === 'website') {
    shell.openExternal(open.url);
  } else if (process.platform === 'darwin') {
    // macOS: `open -a <App>` launches a desktop app; Terminal opens a new window.
    const app = open.via === 'app' ? open.app : 'Terminal';
    exec(`open -a ${JSON.stringify(app)}`, (err) => {
      if (err) log.warn(`[Suggestion] Failed to open ${app}: ${err.message}`);
    });
  } else {
    log.warn(`[Suggestion] Launching ${tool.label} (${open.via}) is only supported on macOS.`);
  }
}

function pruneSuggestionCache() {
  const now = Date.now();
  for (const [key, entry] of suggestionCache) {
    if (now - entry.ts > SUGGESTION_TTL_MS) suggestionCache.delete(key);
  }
}

// Fire the suggestion request for a freshly shown Tier-2 observation and stash
// the promise. Never throws — failures resolve to null so the click path falls
// back to the existing chat flow.
function precomputeSuggestion(event: {
  observation_id?: string;
  observation?: string;
  status?: string;
  task_label?: string;
  scenario?: string;
  image_paths?: string[];
  retrieved_context?: ObservationEvent['retrieved_context'];
}): Promise<InstantSuggestion | null> | undefined {
  const id = event.observation_id;
  if (!id) return undefined;
  const cached = suggestionCache.get(id);
  if (cached) return cached.promise;
  pruneSuggestionCache();

  const { aiTools, scenario } = readProfile();
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const startedAt = Date.now();
  log.info(`[InstantSuggestion] precompute start id=${id} status=${event.status}`);
  personalizationScheduler?.beginInteractiveInference();
  const promise = axios
    .post(
      `http://127.0.0.1:${tutorPort}/suggestion/instant`,
      {
        observation: event.observation ?? '',
        image_paths: event.image_paths?.length ? event.image_paths : null,
        task_label: event.task_label ?? null,
        scenario: event.scenario || scenario,
        ai_tools: aiTools,
        retrieved_context: event.retrieved_context ?? null,
      },
      { timeout: SUGGESTION_REQUEST_TIMEOUT_MS },
    )
    .then((resp) => {
      const data = resp.data as InstantSuggestion;
      recordSupportSuggestion(id, data);
      log.info(`[InstantSuggestion] precompute ready id=${id} kind=${data?.kind} in ${Date.now() - startedAt}ms`);
      return data;
    })
    .catch((err) => {
      log.warn(`[InstantSuggestion] precompute failed for ${id} after ${Date.now() - startedAt}ms: ${(err as { message?: string })?.message}`);
      return null;
    })
    .finally(() => personalizationScheduler?.endInteractiveInference());
  suggestionCache.set(id, { ts: Date.now(), promise });
  return promise;
}

// Renderer asks for the precomputed suggestion when the user clicks "Help me".
// Returns a status the renderer uses to decide between instant reveal and the
// fallback chat flow. Awaits the in-flight promise if it isn't ready yet.
ipcMain.removeHandler('get-instant-suggestion');
ipcMain.handle(
  'get-instant-suggestion',
  async (_event, { observationId }: { observationId?: string }) => {
    const entry = observationId
      ? suggestionCache.get(observationId)
      : undefined;
    if (!entry) {
      log.info(
        `[InstantSuggestion] click: cache MISS id=${observationId ?? '(none)'} — falling back to chat`,
      );
      return { status: 'missing' };
    }
    if (Date.now() - entry.ts > SUGGESTION_TTL_MS) {
      suggestionCache.delete(observationId!);
      return { status: 'stale' };
    }
    const waitStart = Date.now();
    const value = await entry.promise;
    log.info(
      `[InstantSuggestion] click: cache HIT id=${observationId} (waited ${Date.now() - waitStart}ms for in-flight) -> ${value ? 'ready' : 'error'}`,
    );
    if (!value) {
      suggestionCache.delete(observationId!);
      return { status: 'error' };
    }
    // Attach the user's own tools so a delegate bubble can offer one Open button
    // per available chatbot/agent (recommended tool first).
    const suggestion: InstantSuggestion =
      value.kind === 'delegate'
        ? { ...value, availableTools: buildAvailableTools(value.targetTool) }
        : value;
    return { status: 'ready', suggestion };
  },
);

// Renderer acts on a revealed suggestion: always copy the prompt/content to the
// clipboard, and — when the user picked a specific tool — launch it (website,
// app, or terminal) so they can paste. `toolId` omitted means copy-only.
ipcMain.removeAllListeners('suggestion-action');
ipcMain.on(
  'suggestion-action',
  (_event, { toolId, copyText }: { toolId?: string | null; copyText?: string }) => {
    if (copyText) clipboard.writeText(copyText);
    if (toolId) openAiTool(toolId);
  },
);

// Open a revealed instant suggestion in Coco's own conversation. Delegation
// prompts can pre-fill the composer; "Chat about it" attaches the suggestion
// and its observation as context for the user's next message.
ipcMain.removeAllListeners('chat-about-suggestion');
ipcMain.on(
  'chat-about-suggestion',
  async (
    _event,
    payload: {
      observationId?: string;
      status?: string;
      rawObservation?: string;
      suggestion?: InstantSuggestion;
      surface?: 'bubble' | 'notification';
      copyPromptToInput?: boolean;
    },
  ) => {
    if (payload?.surface === 'notification') notificationWindow?.destroy();

    const suggestion = payload?.suggestion;
    if (!suggestion) return;
    const rawObservation = payload.rawObservation?.trim() || '';
    const suggestionText =
      suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body;
    const seed: ChatSeed = payload.copyPromptToInput
      ? {
          phrase: suggestion.title,
          label: payload.status?.replace(/_/g, ' ') || 'suggestion',
          rawObservation,
          initialInput: suggestion.copyText || suggestionText || '',
        }
      : {
          phrase: suggestion.title,
          label: payload.status?.replace(/_/g, ' ') || 'suggestion',
          rawObservation: [
            'I’d like to chat about this suggestion:',
            `**${suggestion.title}**`,
            suggestionText || suggestion.copyText,
            rawObservation
              ? `Context that prompted it:\n${rawObservation}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          deferUntilUserMessage: true,
        };

    if (payload.observationId) {
      recordSupportEngagement(payload.observationId, {
        engagedAt: Math.floor(Date.now() / 1000),
        suggestion,
        destination: 'conversation',
      });
    }
    const sensingPort = process.env.SENSING_PORT || '8080';
    axios
      .post(
        `http://127.0.0.1:${sensingPort}/feedback`,
        {
          kind: 'engage',
          surface: payload.surface ?? 'bubble',
          observation_id: payload.observationId ?? null,
          status: payload.status ?? 'observing',
          text: suggestion.copyText ?? suggestionText ?? null,
        },
        { timeout: 3000 },
      )
      .catch((err) => {
        log.warn(`[Feedback] failed to post: ${(err as Error).message}`);
      })
      .finally(() => personalizationScheduler?.noteFeedback());

    if (isSessionActive && currentSessionId) {
      openChatForSession(currentSessionId, pendingTaskLabel || '', seed);
    } else {
      await createProactiveTutorSession(suggestion.title, 120, seed);
    }
  },
);

// Create a tutor session entirely against the LOCAL servers (no backend). A
// "session" here is just a fresh conversation on the tutor server plus a
// configured struggle-detection window on the sensing server. Shared by the
// "Yes, start session" invite flow and the pre-session "Help me with this"
// flow. Returns the new (locally generated) session id, or null on failure.
async function createProactiveTutorSession(
  problemStatement: string,
  struggleSeconds: number,
  seed?: ChatSeed,
): Promise<string | null> {
  // Read the user's onboarding profile to get their selected AI tools and mode.
  const { aiTools, scenario, customObserverPrompt } = readProfile();

  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const sensing = `http://127.0.0.1:${sensingPort}`;
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const sessionId = randomUUID();
  const modelConfig = readModelConfiguration();
  const selectedTutor = modelConfig ? defaultTutor(modelConfig) : null;
  currentTutorModelId = selectedTutor?.id ?? null;

  // Open the chat panel immediately so the user always gets a UI, even if a
  // server is still starting up. Configuration below is best-effort.
  currentSessionId = sessionId;
  isSessionActive = true;
  openChatForSession(sessionId, problemStatement, seed);
  log.info(`[ProactiveSession] Local tutor session started: ${sessionId}`);

  // Configure the tutor conversation (the chat only needs the tutor server).
  try {
    await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
    if (selectedTutor) {
      await axios.post(
        `${tutor}/config/model`,
        { model: selectedTutor.model },
        { timeout: 8000 },
      );
    }
    await axios.post(`${tutor}/config/scenario`, { scenario }, { timeout: 8000 });
    await axios.post(
      `${tutor}/context/problem_statement`,
      { problem_statement: problemStatement },
      { timeout: 8000 },
    );
    await axios.post(`${tutor}/context/ai_tools`, { ai_tools: aiTools }, { timeout: 8000 });
    // Re-apply the persisted long-term memory so a freshly (re)started tutor
    // process always has it, independent of its own on-disk load.
    const savedMemory = readLocalMemory();
    if (savedMemory) {
      await axios.post(`${tutor}/context/memory`, { memory: savedMemory }, { timeout: 8000 });
    }
  } catch (err) {
    log.warn(`[ProactiveSession] Tutor context setup failed: ${(err as Error).message}`);
  }

  // Configure the sensing session (struggle-detection window + observer prompt).
  // This is proactive-only — chat still works if the sensing server is down.
  try {
    await axios.post(
      `${sensing}/session`,
      {
        node_uuid: sessionId,
        struggle_detection_seconds: struggleSeconds,
        scenario,
        config_source: 'session_start',
        ...(customObserverPrompt && { custom_observer_prompt: customObserverPrompt }),
      },
      { timeout: 15000 },
    );
  } catch (err) {
    log.warn(`[ProactiveSession] Sensing session setup failed (proactive disabled): ${(err as Error).message}`);
  }

  return sessionId;
}

// Start a fresh conversation directly from the chat header. Reuse the regular
// session setup path so tutor context, sensing, profile settings, and long-term
// memory all move to the same new session boundary.
ipcMain.removeHandler('start-new-chat-session');
ipcMain.handle(
  'start-new-chat-session',
  async (_event, { problemStatement }: { problemStatement?: string } = {}) => {
    const task =
      problemStatement?.trim() || pendingTaskLabel || 'General help session';
    try {
      const sessionId = await createProactiveTutorSession(task, 120);
      return { success: Boolean(sessionId), sessionId };
    } catch (err) {
      log.warn(
        `[ProactiveSession] Could not start a new chat session: ${(err as Error).message}`,
      );
      return { success: false, error: (err as Error).message };
    }
  },
);

// Chat history is local-only: the renderer persists completed turns here and
// asks main to rebuild tutor context before continuing an older conversation.
ipcMain.removeHandler('get-chat-conversations');
ipcMain.handle('get-chat-conversations', () => readConversations());

ipcMain.removeHandler('save-chat-conversation');
ipcMain.handle('save-chat-conversation', (_event, payload) => {
  saveConversation({ ...(payload ?? {}), tutorModelId: currentTutorModelId });
  return { success: true };
});

ipcMain.removeHandler('resume-chat-conversation');
ipcMain.handle(
  'resume-chat-conversation',
  async (_event, { sessionId }: { sessionId?: string } = {}) => {
    const conversation = readConversations().find(
      (saved) => saved.sessionId === sessionId,
    );
    if (!conversation) {
      return { success: false, error: 'Conversation not found.' };
    }

    const tutorPort = process.env.TUTOR_PORT || '8081';
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const { aiTools, scenario } = readProfile();
    try {
      await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
      const modelConfig = readModelConfiguration();
      const selectedTutor =
        modelConfig?.tutors.find(
          (item) => item.id === conversation.tutorModelId,
        ) ?? (modelConfig ? defaultTutor(modelConfig) : null);
      if (selectedTutor) {
        await axios.post(
          `${tutor}/config/model`,
          { model: selectedTutor.model },
          { timeout: 8000 },
        );
        currentTutorModelId = selectedTutor.id;
      }
      await axios.post(
        `${tutor}/config/scenario`,
        { scenario },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/problem_statement`,
        { problem_statement: conversation.problem },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/ai_tools`,
        { ai_tools: aiTools },
        { timeout: 8000 },
      );
      const savedMemory = readLocalMemory();
      if (savedMemory) {
        await axios.post(
          `${tutor}/context/memory`,
          { memory: savedMemory },
          { timeout: 8000 },
        );
      }
      await axios.post(
        `${tutor}/context/conversation`,
        {
          messages: conversation.messages
            .filter((message) => !message.isError)
            .map(({ role, text }) => ({ role, text })),
        },
        { timeout: 8000 },
      );
      currentSessionId = conversation.sessionId;
      isSessionActive = true;
      pendingTaskLabel = conversation.problem;
      return { success: true, tutorModelId: currentTutorModelId };
    } catch (err) {
      log.warn(
        `[Chat] Could not resume conversation: ${(err as Error).message}`,
      );
      return { success: false, error: (err as Error).message };
    }
  },
);

// User confirmed the task + struggle-time in the session-setup window.
ipcMain.removeAllListeners('proactive-session-confirmed');
ipcMain.on('proactive-session-confirmed', async (_event, { struggleSeconds, taskLabel }: { struggleSeconds: number; taskLabel?: string }) => {
  sessionSetupWindow?.destroy();
  // Prefer the user-edited task label from the setup window; fall back to
  // the auto-detected pendingTaskLabel, then a generic default.
  const problemStatement = taskLabel?.trim() || pendingTaskLabel || 'General help session';
  await createProactiveTutorSession(problemStatement, struggleSeconds);
});

// User clicked "Yes" in the "task done?" notification — end the session.
// Recap/rating were cloud-analytics features and are intentionally dropped in
// the local build, so this just tears the session down.
ipcMain.removeAllListeners('proactive-session-end-confirmed');
ipcMain.on('proactive-session-end-confirmed', () => {
  notificationWindow?.destroy();
  endCurrentSession();
});

// Ends the active session: mark inactive, close the chat panel, and tell the
// sensing server to revert to pre-session observation mode.
function endCurrentSession() {
  isSessionActive = false;
  currentSessionId = null;
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.hide();
    avatarWindow?.show();
  }
  const sensingPort = process.env.SENSING_PORT || '8080';
  axios
    .post(`http://127.0.0.1:${sensingPort}/session/end`)
    .catch((e) => log.warn('Could not notify sensing server of session end:', e));
}

// ── Local chat turn ────────────────────────────────────────────────────────────
// The renderer (SessionChatView) sends the user's message here. We generate an
// observation of the current screen (best-effort) and ask the local tutor server
// for guidance, returning it synchronously — no backend, DB, or WebSocket.
// Pasted images arrive as data URLs; we persist them to temp files so the tutor
// server (which reads image paths from disk) can include them in the LLM call.
ipcMain.removeHandler('send-chat-message');
ipcMain.handle(
  'send-chat-message',
  async (
    ipcEvent,
    {
      requestId,
      userText,
      images,
      hotkeyImages,
    }: {
      requestId: string;
      userText: string;
      images?: string[];
      hotkeyImages?: string[];
    },
  ) => {
    const tutorPort = process.env.TUTOR_PORT || '8081';
    personalizationScheduler?.beginInteractiveInference();

    // Persist any pasted images to temp files for the tutor's vision call.
    const imagePaths: string[] = [];
    const hotkeyImageSet = new Set(hotkeyImages ?? []);
    let hotkeyImageCount = 0;
    for (const dataUrl of images ?? []) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
      if (!m) continue;
      const ext = m[1].split('/')[1]?.split('+')[0] || 'png';
      const isHotkeyCapture = hotkeyImageSet.has(dataUrl);
      const sourceLabel = isHotkeyCapture ? 'hotkey' : 'paste';
      const file = path.join(
        os.tmpdir(),
        `coco-${sourceLabel}-${randomUUID()}.${ext}`,
      );
      try {
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        imagePaths.push(file);
        if (isHotkeyCapture) hotkeyImageCount += 1;
      } catch (err) {
        log.warn(`[Chat] Failed to write pasted image: ${(err as Error).message}`);
      }
    }

    const contextualizedUserText = hotkeyImageCount > 0
      ? [
          '<hotkey_screenshot_context>',
          `${hotkeyImageCount} attached image${hotkeyImageCount === 1 ? ' was' : 's were'} deliberately captured by the user with Coco's screenshot hotkey.`,
          'Treat the attached hotkey capture as the primary visual state the user chose for this request. Do not call observe_screen merely to capture or inspect the same screen again. Only request a new live-screen observation if the user explicitly asks for an updated view after this capture.',
          '</hotkey_screenshot_context>',
          userText,
        ].filter(Boolean).join('\n')
      : userText;

    try {
      await consumeTutorStream(
        `http://127.0.0.1:${tutorPort}/events/user_prompt/stream`,
        {
          // Current-screen context is now retrieved only when the tutor calls
          // observe_screen; ordinary chat turns skip the observer entirely.
          observation: '',
          session_id: currentSessionId,
          user_text: contextualizedUserText,
          image_paths: imagePaths.length ? imagePaths : null,
        },
        (streamEvent: TutorStreamEvent) => {
          ipcEvent.sender.send('chat-stream-event', {
            requestId,
            ...streamEvent,
            ...(streamEvent.type === 'done'
              ? { observerMetrics: streamEvent.observer_metrics ?? null }
              : {}),
          });
        },
        undefined,
        {
          // This is an activity timeout, refreshed by every SSE chunk (including
          // server keep-alives), plus a separate ceiling for genuinely runaway
          // tool/model loops.
          idleMs: 60_000,
          hardMs: 5 * 60_000,
        },
      );
      return { streamed: true };
    } catch (err) {
      const ax = err as { response?: { data?: unknown }; message?: string };
      log.error('[Chat] streaming user prompt failed:', JSON.stringify(ax?.response?.data ?? ax?.message));
      const error =
        err instanceof TutorStreamTimeoutError
          ? 'The tutor took too long to respond. Please retry.'
          : 'The tutor could not generate a response. Please try again.';
      ipcEvent.sender.send('chat-stream-event', {
        requestId,
        type: 'error',
        error,
      });
      return { error };
    } finally {
      personalizationScheduler?.endInteractiveInference();
    }
  },
);

ipcMain.removeAllListeners('open-image-preview');
ipcMain.on('open-image-preview', (event, payload: unknown) => {
  const imageDataUrl = (payload as { imageDataUrl?: unknown } | null)
    ?.imageDataUrl;
  if (
    typeof imageDataUrl !== 'string' ||
    !imageDataUrl.startsWith('data:image/')
  ) {
    log.warn('[ImagePreview] Ignored an invalid image preview request.');
    return;
  }
  openImagePreviewWindow(
    BrowserWindow.fromWebContents(event.sender),
    imageDataUrl,
  );
});

ipcMain.removeAllListeners('image-preview-ready');
ipcMain.on('image-preview-ready', (event) => {
  if (
    !imagePreviewWindow ||
    imagePreviewWindow.isDestroyed() ||
    imagePreviewWindow.webContents.id !== event.sender.id ||
    !imagePreviewDataUrl
  ) {
    return;
  }
  imagePreviewWindow.webContents.send('image-preview', {
    imageDataUrl: imagePreviewDataUrl,
  });
  imagePreviewWindow.show();
  imagePreviewWindow.focus();
});

ipcMain.removeAllListeners('close-image-preview');
ipcMain.on('close-image-preview', (event) => {
  if (
    imagePreviewWindow &&
    !imagePreviewWindow.isDestroyed() &&
    imagePreviewWindow.webContents.id === event.sender.id
  ) {
    imagePreviewWindow.close();
  }
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

// Note: electron-debug auto-opens DevTools, so we don't use it here
// Instead, we'll register a global shortcut to toggle DevTools manually

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

// IPC Handler for directory selection
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  return result;
});

// IPC Handler for file/directory selection (for context)
ipcMain.handle('select-file-or-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  return result;
});

// IPC Handlers for benchmark file downloads
ipcMain.handle(
  'download-benchmark-file',
  async (event, { apiUrl, taskId, filename, workspaceDir }) => {
    try {
      // Ensure workspace directory exists
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }

      // Download file from server
      const response = await axios.get(
        `${apiUrl}/benchmark_files/download/${taskId}/${encodeURIComponent(filename)}`,
        { responseType: 'arraybuffer' },
      );

      // Save to workspace directory
      const filePath = path.join(workspaceDir, filename);
      fs.writeFileSync(filePath, Buffer.from(response.data));

      log.info(`Downloaded benchmark file: ${filename} to ${filePath}`);
      return { success: true, filePath };
    } catch (error) {
      log.error(`Error downloading benchmark file ${filename}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

ipcMain.handle('get-benchmark-files', async (event, { apiUrl, taskId }) => {
  try {
    const response = await axios.get(
      `${apiUrl}/benchmark_files/list/${taskId}`,
    );
    return { success: true, data: response.data };
  } catch (error) {
    log.error(`Error fetching benchmark file list:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// IPC Handler: the avatar's Activity panel hydrates from persisted history on
// open. `sinceTs` (unix seconds) bounds the read; default returns the last
// 14 days so the contribution strip and today's timeline can both render.
ipcMain.handle('get-activity-history', async (_event, sinceTs?: number) => {
  const defaultSince = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  return readActivity(typeof sinceTs === 'number' ? sinceTs : defaultSince).map(
    (record) => {
      const support = record.proactive_support;
      if (support?.suggestion || !record.observation_id) return record;
      const cached = suggestionCache.get(record.observation_id);
      if (!cached || Date.now() - cached.ts > SUGGESTION_TTL_MS) return record;
      return {
        ...record,
        proactive_support: { ...support, available: true },
      };
    },
  );
});

ipcMain.removeAllListeners('activity-support-engaged');
ipcMain.on('activity-support-engaged', (_event, payload) => {
  const observationId = String(payload?.observationId ?? '');
  if (!observationId) return;
  recordSupportEngagement(observationId, {
    engagedAt:
      typeof payload?.engagedAt === 'number'
        ? payload.engagedAt
        : Math.floor(Date.now() / 1000),
    suggestion: payload?.suggestion,
    destination: payload?.destination === 'inline' ? 'inline' : 'conversation',
  });
});

ipcMain.removeAllListeners('activity-support-rated');
ipcMain.on('activity-support-rated', (_event, payload) => {
  const observationId = String(payload?.observationId ?? '');
  let rating: 'up' | 'down' | null = null;
  if (payload?.rating === 'up' || payload?.rating === 'down') {
    rating = payload.rating;
  }
  if (!observationId || !rating) return;
  recordSupportRating(
    observationId,
    rating,
    typeof payload?.ratedAt === 'number'
      ? payload.ratedAt
      : Math.floor(Date.now() / 1000),
  );
});

// The desktop-avatar toggle is independent from the other editable settings,
// so persist and apply it as soon as the checkbox changes.
ipcMain.removeHandler('update-avatar-visibility');
ipcMain.handle(
  'update-avatar-visibility',
  (_event, { hideAvatar }: { hideAvatar?: boolean } = {}) => {
    if (typeof hideAvatar !== 'boolean') {
      return { success: false, error: 'Invalid avatar visibility setting.' };
    }
    try {
      let profile: Record<string, unknown> = {};
      try {
        profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
      } catch {
        /* no existing profile — start fresh */
      }
      profile.hideAvatar = hideAvatar;
      fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
      applyAvatarVisibility(hideAvatar);
      return { success: true };
    } catch (err) {
      log.error('[Settings] Failed to update avatar visibility:', err);
      return { success: false, error: String(err) };
    }
  },
);

// Update the agent mode + AI tools live from the chat's Settings panel.
// Persists to the profile and applies the change to the running servers so the
// current session picks it up without a restart or re-onboarding.
ipcMain.removeHandler('update-settings');
ipcMain.handle(
  'update-settings',
  async (
    _event,
    {
      scenario,
      aiTools,
      hideAvatar,
    }: {
      scenario: string;
      aiTools: string[];
      hideAvatar: boolean;
    },
  ) => {
    // 1. Persist into the profile (merged with existing fields). Models are
    // configured via .env (TUTOR_MODEL / OBSERVER_MODEL), not here.
    try {
      let profile: Record<string, unknown> = {};
      try {
        profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
      } catch {
        /* no existing profile — start fresh */
      }
      profile.tutorScenario = scenario;
      profile.aiTools = aiTools;
      profile.hideAvatar = hideAvatar === true;
      fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
    } catch (err) {
      log.error('[Settings] Failed to persist profile:', err);
      return { success: false, error: String(err) };
    }

    // Apply the desktop presentation immediately; no restart is required.
    applyAvatarVisibility(hideAvatar === true);

    // 2. Apply live to the running servers (best-effort).
    const sensingPort = process.env.SENSING_PORT || '8080';
    const tutorPort = process.env.TUTOR_PORT || '8081';
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const sensing = `http://127.0.0.1:${sensingPort}`;
    try {
      await axios.post(`${tutor}/config/scenario`, { scenario }, { timeout: 8000 });
      await axios.post(`${tutor}/context/ai_tools`, { ai_tools: aiTools }, { timeout: 8000 });
    } catch (err) {
      log.warn(`[Settings] Tutor update failed: ${(err as Error).message}`);
    }
    // Update the observer/judge scenario too (sensing) if a session is running.
    if (currentSessionId) {
      const { customObserverPrompt } = readProfile();
      try {
        await axios.post(
          `${sensing}/session`,
          {
            node_uuid: currentSessionId,
            struggle_detection_seconds: 120,
            scenario,
            config_source: 'settings',
            ...(customObserverPrompt && { custom_observer_prompt: customObserverPrompt }),
          },
          { timeout: 15000 },
        );
      } catch (err) {
        log.warn(`[Settings] Sensing scenario update failed: ${(err as Error).message}`);
      }
    }
    return { success: true };
  },
);

// Long-term agent memory — viewed/edited from the chat's Settings panel.
// The Electron main process owns the on-disk copy (userData/coco-memory.txt),
// exactly like the profile/settings, so it always survives a restart. The value
// is also pushed to the tutor server for live use (and re-applied on each new
// session — see createProactiveTutorSession).
const memoryPath = () => path.join(app.getPath('userData'), 'coco-memory.txt');

function readLocalMemory(): string {
  try {
    return fs.readFileSync(memoryPath(), 'utf-8');
  } catch {
    return '';
  }
}

ipcMain.removeHandler('get-memory');
ipcMain.handle('get-memory', async () => {
  // The local file is the source of truth and persists across restarts.
  const local = readLocalMemory();
  if (local) return { memory: local };
  // First run / empty file — fall back to whatever the tutor currently holds.
  const tutorPort = process.env.TUTOR_PORT || '8081';
  try {
    const resp = await axios.get(`http://127.0.0.1:${tutorPort}/context/memory`, { timeout: 8000 });
    return { memory: String((resp.data as { memory?: unknown })?.memory ?? '') };
  } catch {
    return { memory: '' };
  }
});

ipcMain.removeHandler('save-memory');
ipcMain.handle('save-memory', async (_event, { memory }: { memory: string }) => {
  // 1. Persist to disk in userData (authoritative — like the profile).
  try {
    fs.writeFileSync(memoryPath(), memory ?? '', 'utf-8');
    log.info('[Memory] saved to', memoryPath());
  } catch (err) {
    log.error('[Memory] failed to persist:', err);
    return { success: false, error: String(err) };
  }
  // 2. Apply live to the running tutor (best-effort).
  const tutorPort = process.env.TUTOR_PORT || '8081';
  try {
    await axios.post(`http://127.0.0.1:${tutorPort}/context/memory`, { memory }, { timeout: 8000 });
  } catch (err) {
    log.warn(`[Memory] live apply failed: ${(err as Error).message}`);
  }
  return { success: true };
});

ipcMain.removeHandler('get-daily-memory-draft');
ipcMain.handle('get-daily-memory-draft', () => ({
  draft: dailyMemoryDraftService?.claimForToday() ?? null,
}));

ipcMain.removeHandler('approve-daily-memory-draft');
ipcMain.handle(
  'approve-daily-memory-draft',
  async (_event, { draftId }: { draftId?: string } = {}) => {
    if (!dailyMemoryDraftService || !draftId) {
      return { success: false, error: 'Memory update is not available.' };
    }
    try {
      const { memory: evolvedMemory, draft } =
        dailyMemoryDraftService.approve(draftId);
      const tutorPort = process.env.TUTOR_PORT || '8081';
      try {
        await axios.post(
          `http://127.0.0.1:${tutorPort}/context/evolved_memory`,
          { memory: evolvedMemory },
          { timeout: 8000 },
        );
      } catch (err) {
        // The separate evolved-memory file is authoritative and is loaded when
        // the tutor starts.
        log.warn(`[Memory] daily update live apply failed: ${(err as Error).message}`);
      }
      log.info(`[Memory] approved daily personalization draft ${draft.draftId}`);
      return { success: true, draftId: draft.draftId };
    } catch (err) {
      log.warn(`[Memory] failed to approve daily update: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  },
);

// IPC Handler for setting the local user id (used only to key training data).
// There is no auth backend in the local build; the id is a stable local uuid.
ipcMain.handle('set-user-id', async (event, userId) => {
  if (!userId || typeof userId !== 'string') {
    log.error('Invalid userId provided to set-user-id');
    return { success: false, error: 'Invalid userId' };
  }
  currentUserId = userId;
  log.info(`[User] local userId set to ${userId}`);
  return { success: true };
});

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const onboardingComplete = isOnboardingComplete();
  const modelConfiguration = readModelConfiguration();
  if (!onboardingComplete) {
    // First launch — show onboarding. The avatar is created after the user
    // completes or skips onboarding (see 'onboarding-complete' handler).
    createOnboardingWindow();
    createTray();
  } else if (!modelConfiguration) {
    // Legacy environment variables may be sufficient to start the services,
    // but users still need an explicit, inspectable model configuration.
    createOnboardingWindow(true);
    createTray();
  } else {
    applyAvatarVisibility(readHideAvatarSetting());
  }

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin' && !hideAvatarMode) {
    app.quit();
  }
});

app.on('second-instance', () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
  } else if (chatWindow && !chatWindow.isDestroyed()) {
    showChatPanel();
  } else if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.show();
    avatarWindow.focus();
  } else {
    openPrimaryTrayAction();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
});

// Warning shown when neither first-launch configuration nor legacy developer
// environment variables provide both required model roles.
const showModelsRequiredWarning = () => {
  showNotification({
    message:
      'Coco is paused. Open Settings and configure a sensing model and at least one tutor model.',
    actionLabel: 'Got it',
  });
};

// Effective model ids. Managed app configuration wins when present; legacy
// developer environment variables remain supported as a fallback.
const effectiveModels = (): { tutor: string; observer: string } => {
  const runtime = resolveModelRuntime();
  return {
    tutor: (
      runtime ? defaultTutor(runtime.config).model : process.env.TUTOR_MODEL || ''
    ).trim(),
    observer: (
      runtime?.config.sensing.model || process.env.OBSERVER_MODEL || ''
    ).trim(),
  };
};

// Starts the sensing services and observation stream. Called once onboarding
// is complete (or immediately on subsequent launches where it's already done),
// and again from update-settings the moment the user first saves their models.
const startObserver = () => {
  // Already running — nothing to do (guards the two call sites + the
  // start-on-save path in update-settings).
  if (observerStarted) return;

  // Gate on model choice: until BOTH roles are explicitly set, do not spawn
  // Python services that could otherwise start with an unintended provider.
  const { tutor: tutorModel, observer: observerModel } = effectiveModels();
  if (!tutorModel || !observerModel) {
    log.warn('[Models] No models chosen yet — services not started.');
    showModelsRequiredWarning();
    return;
  }
  observerStarted = true;

  // Shared records directory. Both the sensing server (observer/judge) and the
  // tutor server read $COCO_RECORDS_DIR so all their JSONL logs — and, in
  // training-collection mode, retained screenshots — land in one joinable
  // directory. It lives alongside the user's other local data (memory,
  // profile, activity history) under the app's userData dir. Set before
  // services spawn so the children inherit it.
  if (!process.env.COCO_RECORDS_DIR) {
    const dir = path.join(
      app.getPath('userData'),
      'coco-records',
      `session_${Math.floor(Date.now() / 1000)}`,
    );
    process.env.COCO_RECORDS_DIR = dir;
    log.info(`[Records] COCO_RECORDS_DIR=${dir}`);
  }

  // Expose the app's user-data dir to the services so sensing can persist the
  // user's custom observer prompt (Custom mode) to its own file there. Set
  // before services spawn so the children inherit it.
  if (!process.env.COCO_USER_DATA_DIR) {
    process.env.COCO_USER_DATA_DIR = app.getPath('userData');
    log.info(`[Profile] COCO_USER_DATA_DIR=${process.env.COCO_USER_DATA_DIR}`);
  }
  // Unlike per-launch training records, GUM memory is intentionally shared
  // across sessions so the tutor can retrieve older context.
  if (!process.env.COCO_MEMORY_DB_PATH) {
    process.env.COCO_MEMORY_DB_PATH = path.join(
      app.getPath('userData'),
      'memory',
      'memory.db',
    );
    log.info(`[Memory] COCO_MEMORY_DB_PATH=${process.env.COCO_MEMORY_DB_PATH}`);
  }

  // Pass the resolved models to the services. config.json references
  // ${TUTOR_MODEL}/${OBSERVER_MODEL}, which the service manager expands from env.
  process.env.TUTOR_MODEL = tutorModel;
  process.env.OBSERVER_MODEL = observerModel;
  log.info(`[Models] tutor=${tutorModel} observer=${observerModel}`);

  try {
    // services.json may be loaded earlier while choosing available ports. On a
    // clean install there is no legacy .env, so its model placeholders have
    // already expanded to empty strings by this point. Always apply the saved
    // model IDs directly before startup instead of relying on load-time env
    // expansion.
    configureServiceModelArguments(
      serviceManager,
      tutorModel,
      observerModel,
    );
    const runtime = resolveModelRuntime();
    if (runtime) {
      const { userName } = readProfile();
      serviceManager.configureServiceEnv(
        'tutor-server',
        runtime.tutorEnv,
        true,
      );
      serviceManager.configureServiceEnv(
        'sensing-server',
        {
          ...runtime.sensingEnv,
          ...(userName && { COCO_USER_NAME: userName }),
        },
        true,
      );
    }
    serviceManager.startAll();

    const recordsRoot = path.join(app.getPath('userData'), 'coco-records');
    const stateRoot = path.join(app.getPath('userData'), 'personalization');
    initializeDailyMemoryDraftService();
    const packagedExecutable = app.isPackaged
      ? path.join(
          process.resourcesPath,
          'service-dist',
          'coco-services',
          `personalization-worker${process.platform === 'win32' ? '.exe' : ''}`,
        )
      : undefined;
    personalizationScheduler = new PersonalizationScheduler({
      projectRoot: app.isPackaged
        ? path.dirname(packagedExecutable!)
        : path.resolve(process.cwd(), '..'),
      recordsRoot,
      stateRoot,
      memoryRoot: app.getPath('userData'),
      model: observerModel,
      packagedExecutable,
      providerEnv: runtime?.sensingEnv,
      collectTrainingScreenshots: ['1', 'true', 'yes'].includes(
        (process.env.COLLECT_TRAINING_SCREENSHOTS ?? '').toLowerCase(),
      ),
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      onJobComplete: (job) => {
        if (job === 'evolve') {
          avatarWindow?.webContents.send('daily-memory-draft-refresh');
        }
      },
    });
    personalizationScheduler.start();
  } catch (e) {
    console.warn('Failed to start services:', e);
  }

  // Trim old activity history once per launch so the JSONL stays bounded.
  pruneActivity(Math.floor(Date.now() / 1000));

  // Subscribe to the sensing server's live observation feed and forward
  // each event to the avatar window. The SSE client retries with backoff,
  // so it's safe to start before the sensing server is fully up.
  const sensingPort = process.env.SENSING_PORT || '8080';
  startObservationStream({
    url: `http://127.0.0.1:${sensingPort}/observations/stream`,
    onEvent: (event) => {
      if (event.observation) personalizationScheduler?.noteObservation();
      if (observationSleepGuard.shouldSuppress(event.ts)) {
        if (event.observation) {
          log.info(
            `[Power] Dropped suppressed observation status=${event.status ?? '(none)'}`,
          );
        }
        return;
      }

      const status = event.status;

      // Tier-2 friction events from the struggle/pause path arrive without an
      // observation_id, but the precompute cache and the renderer bubble must
      // agree on a key. Since the SAME event object is forwarded to the
      // renderer below, stamp a synthetic id here so both sides line up.
      if (status && PRECOMPUTE_STATUSES.has(status) && !event.observation_id) {
        syntheticObsSeq += 1;
        event.observation_id = `synthetic-${Date.now()}-${syntheticObsSeq}`;
      }

      // Always forward to avatar window for pet animation / observation bubble.
      if (
        !hideAvatarMode &&
        avatarWindow &&
        !avatarWindow.isDestroyed()
      ) {
        avatarWindow.webContents.send('observation-update', event);
      }

      // Tee into the persistent activity history so the Activity panel survives
      // window reloads and spans sessions. appendActivity ignores statuses that
      // don't belong on the timeline (task_suggested / task_complete).
      if (status && event.observation) {
        appendActivity({
          ts: event.ts ?? Math.floor(Date.now() / 1000),
          status: status as ObservationStatus,
          need_support: event.need_support,
          observation: cleanObservation(event.observation),
          observation_id: event.observation_id,
          proactive_support: PRECOMPUTE_STATUSES.has(status)
            ? { engaged: false }
            : undefined,
          llm_metrics: event.llm_metrics,
        });
      }

      const taskLabel = event.task_label;

      // ── Eagerly precompute an instant suggestion for Tier-2 bubbles ───
      // Fire the moment the bubble appears so it's ready by click time. Done
      // regardless of session state — the renderer reveals it instantly either
      // way, falling back to the chat flow only on a cache miss.
      if (status && PRECOMPUTE_STATUSES.has(status)) {
        const suggestionPromise = precomputeSuggestion(event);
        if (hideAvatarMode && event.observation) {
          const rawObservation = cleanObservation(event.observation);
          latestHiddenSuggestionObservationId = event.observation_id;
          void suggestionPromise?.then((value) => {
            // Hidden-avatar notifications preview the generated suggestion,
            // rather than the observer diagnosis that led to it.
            if (
              !value ||
              !hideAvatarMode ||
              latestHiddenSuggestionObservationId !== event.observation_id
            ) {
              return;
            }
            const suggestion: InstantSuggestion =
              value.kind === 'delegate'
                ? {
                    ...value,
                    availableTools: buildAvailableTools(value.targetTool),
                  }
                : value;
            showNotification({
              message: suggestion.title,
              actionLabel: 'Reveal full suggestion',
              notifType: 'proactive-suggestion',
              observationId: event.observation_id,
              status,
              rawObservation,
              suggestion,
            });
            const sensingPort = process.env.SENSING_PORT || '8080';
            axios.post(
              `http://127.0.0.1:${sensingPort}/feedback`,
              {
                kind: 'shown',
                surface: 'notification',
                observation_id: event.observation_id ?? null,
                status,
              },
              { timeout: 3000 },
            )
              .catch((err) => {
                log.warn(`[Feedback] failed to post: ${(err as Error).message}`);
              })
              .finally(() => personalizationScheduler?.noteFeedback());
          });
        }
      }

      // ── Pre-session: suggest starting a tutor session ─────────────────
      // The sensing-side judge now owns the invite decision AND its timing
      // (it only emits a task_suggested event when it decides to invite, at
      // most once per its cooldown), so we no longer rate-limit here.
      if (
        !isSessionActive &&
        status === 'task_suggested' &&
        taskLabel
      ) {
        pendingTaskLabel = taskLabel;
        const message = `I see you're ${taskLabel}. Want me to guide you with AI tools?`;
        showNotification({
          message,
          actionLabel: 'Yes, start session',
          cancelLabel: 'Not now',
          notifType: 'session-start-prompt',
        });
      }

      // ── In-session: detect task completion ───────────────────────────
      if (isSessionActive && status === 'task_complete') {
        showNotification({
          message: "Looks like your task is done. Want to wrap up this session?",
          actionLabel: 'Yes, end session',
          cancelLabel: 'Keep going',
          notifType: 'session-end-prompt',
        });
      }
    },
  });
};

app
  .whenReady()
  .then(async () => {
    await configureLocalServicePorts();
    initializeDailyMemoryDraftService();
    powerMonitor.on('suspend', () => {
      log.info('[Power] System suspended; clearing proactive UI and cache.');
      observationSleepGuard.suspend();
      latestHiddenSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('system-suspend');
      }
    });

    powerMonitor.on('resume', () => {
      log.info('[Power] System resumed; suppressing observations briefly.');
      observationSleepGuard.resume();
      latestHiddenSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        // Send this again in case the renderer was frozen before handling the
        // suspend event.
        avatarWindow.webContents.send('system-suspend');
        avatarWindow.webContents.send('daily-memory-draft-refresh');
      }
    });

    // Ensure default workspace directory exists
    ensureDefaultWorkspaceExists();

    // Only start the observer if onboarding is already done. If not, it will
    // be started by the 'onboarding-complete' IPC handler after the user
    // finishes or skips onboarding.
    const canStartConfiguredModels = Boolean(
      readModelConfiguration() ||
        (process.env.TUTOR_MODEL?.trim() && process.env.OBSERVER_MODEL?.trim()),
    );
    if (
      isOnboardingComplete() &&
      canStartConfiguredModels &&
      !isDailyMemoryPreviewOnly()
    ) {
      hideAvatarMode = readHideAvatarSetting();
      startObserver();
    }

    createWindow();

    // Register global shortcut to toggle DevTools (Cmd/Ctrl+Shift+I)
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const devTarget =
        BrowserWindow.getFocusedWindow() ?? chatWindow ?? avatarWindow;
      if (devTarget && devTarget.webContents) {
        devTarget.webContents.toggleDevTools();
      }
    });

    // Register global shortcut for screenshot capture (Cmd+Shift+Space).
    // Works system-wide even when Electron is not the focused app.
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      // Open the chat panel immediately so the preview has somewhere to land
      // (and the keypress feels responsive). If it was closed, this creates a
      // fresh renderer whose readiness handshake drives the flush below.
      showChatPanel();

      const sensingPort = process.env.SENSING_PORT || '8080';
      const req = require('http').request(
        { hostname: '127.0.0.1', port: sensingPort, path: '/hotkey/capture', method: 'POST' },
        (res: import('http').IncomingMessage) => {
          // Read the capture response and buffer its image, then flush to the
          // chat input bar. flushHotkeyCaptures() no-ops until the renderer is
          // ready, so a just-opened window still gets the capture once mounted.
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const dataUrl = body?.image_data_url;
              if (!dataUrl) return;
              pendingHotkeyCaptures.push(dataUrl);
              flushHotkeyCaptures();
            } catch {
              // Ignore malformed responses — capture still lands server-side.
            }
          });
        }
      );
      req.on('error', () => {}); // silent if sensing server is not running
      req.end();
    });

    // Cmd/Ctrl+Shift+H — toggle the observation history panel on the avatar.
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('toggle-observation-history');
      }
    });

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (avatarWindow === null && chatWindow === null) createWindow();
    });
  })
  .catch(console.log);

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  log.info('App quitting: waiting up to 10s for services to stop...');
  stopObservationStream();
  personalizationScheduler?.stop();
  const shutdownTimeoutMs = 10_000;
  serviceManager
    .shutdown(shutdownTimeoutMs)
    .then(() => {
      log.info('Services stopped, quitting app.');
      app.quit();
    })
    .catch((e) => {
      log.warn('Error while stopping services, quitting anyway', e);
      app.quit();
    });
});
