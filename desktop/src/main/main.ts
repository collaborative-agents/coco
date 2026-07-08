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
import { exec } from 'child_process';
import {
  app,
  BrowserWindow,
  shell,
  clipboard,
  ipcMain,
  globalShortcut,
  Notification,
  dialog,
  screen,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import axios from 'axios';
import { resolveHtmlPath } from './util';
import { serviceManager } from './services/manager';
import {
  startObservationStream,
  stopObservationStream,
} from './services/observation-stream';
import {
  appendActivity,
  readActivity,
  pruneActivity,
} from './activity-store';
import { cleanObservation, AI_TOOLS, resolveAiTools, parseAiTool } from '../renderer/components/observation-types';
import type { ObservationStatus, AiToolButton } from '../renderer/components/observation-types';

const dotenv = require('dotenv');

app.setName('coco');

if (app.isPackaged) {
  dotenv.config({ path: path.join(process.resourcesPath, '.env') });
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
// sessionSetupWindow: small floating window for proactive session config
let avatarWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let notificationWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let sessionSetupWindow: BrowserWindow | null = null;
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

// ── Proactive session state ───────────────────────────────────────────────────
let isSessionActive = false;
let currentUserId: string | null = null;
let currentSessionId: string | null = null;
let pendingTaskLabel: string | null = null;
// Invite timing is owned by the sensing-side judge; no renderer-side cooldown.

// Preload path helper
const preloadPath = () =>
  app.isPackaged
    ? path.join(__dirname, 'preload.js')
    : path.join(__dirname, '../../.erb/dll/preload.js');

// ── Onboarding window ─────────────────────────────────────────────────────────
// Shown once on first launch (when coco-profile.json doesn't exist yet).
// Centered modal; after the user completes or skips it, the profile is written
// and the normal avatar + webapp windows are created.

const createOnboardingWindow = () => {
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

  const url = `${resolveHtmlPath('index.html')}?view=onboarding`;
  onboardingWindow.loadURL(url);

  onboardingWindow.on('ready-to-show', () => {
    onboardingWindow?.show();
  });

  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
  });
};

// ── Avatar window ─────────────────────────────────────────────────────────────

const createAvatarWindow = () => {
  if (avatarWindow && !avatarWindow.isDestroyed()) return;

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
    if (process.env.START_MINIMIZED) {
      avatarWindow?.minimize();
    } else {
      avatarWindow?.show();
    }
  });

  avatarWindow.on('closed', () => { avatarWindow = null; });

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

const createChatWindow = () => {
  if (chatWindow && !chatWindow.isDestroyed()) return;

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

  // Closing hides rather than destroys so the in-memory conversation survives a
  // reopen; the avatar always comes back to the foreground. On a real app quit
  // (isQuitting) we let the window close so shutdown isn't blocked.
  chatWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    chatWindow?.hide();
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
  if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.isVisible()) {
    avatarWindow.show();
  }
};

// Open the chat panel for a session, pushing the session context (and an
// optional observation to auto-send as the first message) once it's loaded.
const openChatForSession = (
  sessionId: string,
  problemStatement: string,
  seed?: { phrase: string; label: string; rawObservation: string },
) => {
  const alreadyLoaded = chatWindow && !chatWindow.isDestroyed();
  isFloatMode = true;
  showChatPanel();
  if (!chatWindow) return;

  const send = () => {
    chatWindow?.webContents.send('session-init', { sessionId, problemStatement });
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
// Markdown bodies render taller than plain text, so allocate more room and
// let the body itself scroll if guidance overflows. header≈38 + body≈210 + footer≈49.
const NOTIF_HEIGHT = 300;

type VizState = 'none' | 'success' | 'error';
type NotifType = 'default' | 'session-start-prompt' | 'session-end-prompt';

const showNotification = (payload: {
  message: string;
  actionLabel: string;
  vizState?: VizState;
  notifType?: NotifType;
  cancelLabel?: string;
}) => {
  // Destroy any existing notification before showing a new one (dedup guard).
  notificationWindow?.destroy();

  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const x = sw - NOTIF_WIDTH - 16;
  const y = 16;

  notificationWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath() },
  });

  const url = `${resolveHtmlPath('index.html')}?view=notification`;
  notificationWindow.loadURL(url);

  notificationWindow.on('ready-to-show', () => {
    notificationWindow?.show();
    notificationWindow?.webContents.send('notification', payload);
  });

  notificationWindow.on('closed', () => { notificationWindow = null; });
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
  createAvatarWindow();
});

// Pet click / "open chat". If a session is already active, reopen its chat
// panel; otherwise start a fresh local session so there is a conversation to
// show (the sensing observer keeps running either way).
ipcMain.removeAllListeners('open-main-window');
ipcMain.on('open-main-window', async () => {
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '');
    return;
  }
  const problemStatement = pendingTaskLabel || 'General help session';
  await createProactiveTutorSession(problemStatement, 120);
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

// Forward an explicit user reaction (bubble engage/dismiss) to the sensing
// server's /feedback endpoint, which logs it into the shared training data.
ipcMain.removeAllListeners('training-feedback');
ipcMain.on('training-feedback', async (_event, payload) => {
  try {
    const sensingPort = process.env.SENSING_PORT || '8080';
    await axios.post(`http://127.0.0.1:${sensingPort}/feedback`, payload ?? {}, {
      timeout: 3000,
    });
  } catch (err) {
    log.warn(`[Feedback] failed to post: ${(err as { message?: string })?.message}`);
  }
});

ipcMain.removeAllListeners('notification');
ipcMain.on('notification', (_event, args) => {
  const { msg, buttonText } = args;
  showNotification({
    message: msg,
    actionLabel: buttonText,
  });
});

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
  tutorModel: string;
  observerModel: string;
} {
  let aiTools: string[] = [];
  let scenario = 'everyday_support';
  let customObserverPrompt = '';
  // Empty when the user hasn't chosen a model. The Python services requires
  // an explicit model, so an empty value here must never reach them —
  // startObserver() gates on both models being set before spawning the services.
  let tutorModel = '';
  let observerModel = '';
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
    if (typeof profile.tutorModel === 'string' && profile.tutorModel.trim()) {
      tutorModel = profile.tutorModel.trim();
    }
    if (typeof profile.observerModel === 'string' && profile.observerModel.trim()) {
      observerModel = profile.observerModel.trim();
    }
    // "Custom" mode customizes only the sensing observer prompt. The judge/tutor
    // still run on a real base scenario, so map 'custom' → 'everyday_support'.
    if (scenario === 'custom') {
      scenario = 'everyday_support';
    }
  } catch (err) {
    log.warn(`[Profile] Could not read profile at ${profilePath()}: ${err}.`);
  }
  return { aiTools, scenario, customObserverPrompt, tutorModel, observerModel };
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
}

const suggestionCache = new Map<string, { ts: number; promise: Promise<InstantSuggestion | null> }>();
const SUGGESTION_TTL_MS = 5 * 60_000;
// Monotonic counter for synthesizing observation ids on events that lack one.
let syntheticObsSeq = 0;
// Statuses that show a "Help me with this" button (mirrors the renderer's
// TIER2_STATUSES in App.tsx). Only these warrant a precompute.
const PRECOMPUTE_STATUSES = new Set([
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
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
}) {
  const id = event.observation_id;
  if (!id || suggestionCache.has(id)) return;
  pruneSuggestionCache();

  const { aiTools, scenario } = readProfile();
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const startedAt = Date.now();
  log.info(`[InstantSuggestion] precompute start id=${id} status=${event.status}`);
  const promise = axios
    .post(
      `http://127.0.0.1:${tutorPort}/suggestion/instant`,
      {
        observation: event.observation ?? '',
        task_label: event.task_label ?? null,
        scenario: event.scenario || scenario,
        ai_tools: aiTools,
      },
      { timeout: 12000 },
    )
    .then((resp) => {
      const data = resp.data as InstantSuggestion;
      log.info(`[InstantSuggestion] precompute ready id=${id} kind=${data?.kind} in ${Date.now() - startedAt}ms`);
      return data;
    })
    .catch((err) => {
      log.warn(`[InstantSuggestion] precompute failed for ${id} after ${Date.now() - startedAt}ms: ${(err as { message?: string })?.message}`);
      return null;
    });
  suggestionCache.set(id, { ts: Date.now(), promise });
}

// Renderer asks for the precomputed suggestion when the user clicks "Help me".
// Returns a status the renderer uses to decide between instant reveal and the
// fallback chat flow. Awaits the in-flight promise if it isn't ready yet.
ipcMain.removeHandler('get-instant-suggestion');
ipcMain.handle('get-instant-suggestion', async (_event, { observationId }: { observationId?: string }) => {
  const entry = observationId ? suggestionCache.get(observationId) : undefined;
  if (!entry) {
    log.info(`[InstantSuggestion] click: cache MISS id=${observationId ?? '(none)'} — falling back to chat`);
    return { status: 'missing' };
  }
  if (Date.now() - entry.ts > SUGGESTION_TTL_MS) {
    suggestionCache.delete(observationId!);
    return { status: 'stale' };
  }
  const waitStart = Date.now();
  const value = await entry.promise;
  log.info(`[InstantSuggestion] click: cache HIT id=${observationId} (waited ${Date.now() - waitStart}ms for in-flight) -> ${value ? 'ready' : 'error'}`);
  if (!value) return { status: 'error' };
  // Attach the user's own tools so a delegate bubble can offer one Open button
  // per available chatbot/agent (recommended tool first).
  const suggestion: InstantSuggestion =
    value.kind === 'delegate'
      ? { ...value, availableTools: buildAvailableTools(value.targetTool) }
      : value;
  return { status: 'ready', suggestion };
});

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

// Create a tutor session entirely against the LOCAL servers (no backend). A
// "session" here is just a fresh conversation on the tutor server plus a
// configured struggle-detection window on the sensing server. Shared by the
// "Yes, start session" invite flow and the pre-session "Help me with this"
// flow. Returns the new (locally generated) session id, or null on failure.
async function createProactiveTutorSession(
  problemStatement: string,
  struggleSeconds: number,
  seed?: { phrase: string; label: string; rawObservation: string },
): Promise<string | null> {
  // Read the user's onboarding profile to get their selected AI tools and mode.
  const { aiTools, scenario, customObserverPrompt } = readProfile();

  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const sensing = `http://127.0.0.1:${sensingPort}`;
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const sessionId = randomUUID();

  // Open the chat panel immediately so the user always gets a UI, even if a
  // server is still starting up. Configuration below is best-effort.
  currentSessionId = sessionId;
  isSessionActive = true;
  openChatForSession(sessionId, problemStatement, seed);
  log.info(`[ProactiveSession] Local tutor session started: ${sessionId}`);

  // Configure the tutor conversation (the chat only needs the tutor server).
  try {
    await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
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
        ...(customObserverPrompt && { custom_observer_prompt: customObserverPrompt }),
      },
      { timeout: 15000 },
    );
  } catch (err) {
    log.warn(`[ProactiveSession] Sensing session setup failed (proactive disabled): ${(err as Error).message}`);
  }

  return sessionId;
}

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
  async (_event, { userText, images }: { userText: string; images?: string[] }) => {
    const sensingPort = process.env.SENSING_PORT || '8080';
    const tutorPort = process.env.TUTOR_PORT || '8081';

    // Persist any pasted images to temp files for the tutor's vision call.
    const imagePaths: string[] = [];
    for (const dataUrl of images ?? []) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
      if (!m) continue;
      const ext = m[1].split('/')[1]?.split('+')[0] || 'png';
      const file = path.join(os.tmpdir(), `coco-paste-${randomUUID()}.${ext}`);
      try {
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        imagePaths.push(file);
      } catch (err) {
        log.warn(`[Chat] Failed to write pasted image: ${(err as Error).message}`);
      }
    }

    // Best-effort screen observation for context (chat still works without it).
    let observation = '';
    try {
      const obs = await axios.post(
        `http://127.0.0.1:${sensingPort}/observe/user_prompt`,
        { text: userText },
        { timeout: 30000 },
      );
      observation = String(obs.data?.observation ?? '');
    } catch (err) {
      log.warn(`[Chat] observe/user_prompt failed: ${(err as Error).message}`);
    }

    try {
      const resp = await axios.post(
        `http://127.0.0.1:${tutorPort}/events/user_prompt`,
        {
          observation,
          user_text: userText,
          image_paths: imagePaths.length ? imagePaths : null,
        },
        { timeout: 120000 },
      );
      return { guidance: String(resp.data?.guidance ?? '') };
    } catch (err) {
      const ax = err as { response?: { data?: unknown }; message?: string };
      log.error('[Chat] events/user_prompt failed:', JSON.stringify(ax?.response?.data ?? ax?.message));
      return { error: 'The tutor could not generate a response. Please try again.' };
    }
  },
);

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
  return readActivity(typeof sinceTs === 'number' ? sinceTs : defaultSince);
});

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
      tutorModel,
      observerModel,
    }: {
      scenario: string;
      aiTools: string[];
      tutorModel?: string;
      observerModel?: string;
    },
  ) => {
    // Empty means "no explicit choice". The services require a model, so an
    // empty value is never sent: the start/live-apply steps below are all gated
    // on a non-empty model (services stay gated off until the user picks one).
    const nextTutorModel = (tutorModel ?? '').trim();
    const nextObserverModel = (observerModel ?? '').trim();
    // 1. Persist into the profile (merged with existing fields).
    try {
      let profile: Record<string, unknown> = {};
      try {
        profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
      } catch {
        /* no existing profile — start fresh */
      }
      profile.tutorScenario = scenario;
      profile.aiTools = aiTools;
      profile.tutorModel = nextTutorModel;
      profile.observerModel = nextObserverModel;
      fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
    } catch (err) {
      log.error('[Settings] Failed to persist profile:', err);
      return { success: false, error: String(err) };
    }

    // Keep the env in sync so a later service (re)start uses the new models.
    process.env.TUTOR_MODEL = nextTutorModel;
    process.env.OBSERVER_MODEL = nextObserverModel;

    // If the services were gated off waiting for a model choice, boot them now
    // (with the models just saved). The live-apply below then no-ops on the
    // cold start since the servers come up already configured.
    if (!observerStarted && nextTutorModel && nextObserverModel) {
      log.info('[Settings] Models configured — starting services.');
      startObserver();
    }

    // 2. Apply live to the running servers (best-effort).
    const sensingPort = process.env.SENSING_PORT || '8080';
    const tutorPort = process.env.TUTOR_PORT || '8081';
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const sensing = `http://127.0.0.1:${sensingPort}`;
    try {
      await axios.post(`${tutor}/config/scenario`, { scenario }, { timeout: 8000 });
      await axios.post(`${tutor}/context/ai_tools`, { ai_tools: aiTools }, { timeout: 8000 });
      // Only push a model when the user set one; an empty choice keeps whatever
      // model the service is already running until the next restart.
      if (nextTutorModel) {
        await axios.post(`${tutor}/config/model`, { model: nextTutorModel }, { timeout: 8000 });
      }
    } catch (err) {
      log.warn(`[Settings] Tutor update failed: ${(err as Error).message}`);
    }
    // Swap the observer model live (no restart) on the sensing server.
    if (nextObserverModel) {
      try {
        await axios.post(
          `${sensing}/config/observer_model`,
          { model: nextObserverModel },
          { timeout: 8000 },
        );
      } catch (err) {
        log.warn(`[Settings] Observer model update failed: ${(err as Error).message}`);
      }
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

  if (!isOnboardingComplete()) {
    // First launch — show onboarding. The avatar is created after the user
    // completes or skips onboarding (see 'onboarding-complete' handler).
    createOnboardingWindow();
  } else {
    createAvatarWindow();
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
});

// Warning shown when the user hasn't chosen their models yet. Its action opens
// the chat (where ⚙ Settings → Models lives).
const showModelsRequiredWarning = () => {
  showNotification({
    message:
      'Coco is paused. Choose a tutor and an observer model to begin — open the chat, then ⚙ Settings → Models. Coco starts sensing as soon as you save.',
    actionLabel: 'Open settings',
  });
};

// Effective model ids: an explicit shell/.env value wins, else the saved
// profile (Settings → Models). Empty string when neither is set.
const effectiveModels = (): { tutor: string; observer: string } => {
  const { tutorModel, observerModel } = readProfile();
  return {
    tutor: (process.env.TUTOR_MODEL || tutorModel || '').trim(),
    observer: (process.env.OBSERVER_MODEL || observerModel || '').trim(),
  };
};

// Starts the sensing services and observation stream. Called once onboarding
// is complete (or immediately on subsequent launches where it's already done),
// and again from update-settings the moment the user first saves their models.
const startObserver = () => {
  // Already running — nothing to do (guards the two call sites + the
  // start-on-save path in update-settings).
  if (observerStarted) return;

  // Gate on model choice: until BOTH a tutor and an observer model are set
  // (via Settings → Models, or TUTOR_MODEL/OBSERVER_MODEL in the env), we do
  // not spawn the Python services. Instead we surface a warning that routes to
  // Settings. Saving models calls startObserver() again, passing this gate.
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

  // Pass the resolved models to the services. config.json references
  // ${TUTOR_MODEL}/${OBSERVER_MODEL}, which the service manager expands from env.
  process.env.TUTOR_MODEL = tutorModel;
  process.env.OBSERVER_MODEL = observerModel;
  log.info(`[Models] tutor=${tutorModel} observer=${observerModel}`);

  try {
    serviceManager.startAll();
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
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('observation-update', event);
      }

      // Tee into the persistent activity history so the Activity panel survives
      // window reloads and spans sessions. appendActivity ignores statuses that
      // don't belong on the timeline (task_suggested / task_complete).
      if (status && event.observation) {
        appendActivity({
          ts: event.ts ?? Math.floor(Date.now() / 1000),
          status: status as ObservationStatus,
          observation: cleanObservation(event.observation),
        });
      }

      const taskLabel = event.task_label;

      // ── Eagerly precompute an instant suggestion for Tier-2 bubbles ───
      // Fire the moment the bubble appears so it's ready by click time. Done
      // regardless of session state — the renderer reveals it instantly either
      // way, falling back to the chat flow only on a cache miss.
      if (status && PRECOMPUTE_STATUSES.has(status)) {
        precomputeSuggestion(event);
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
        showNotification({
          message: `I see you're ${taskLabel}. Want me to guide you with AI tools?`,
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
  .then(() => {
    // Ensure default workspace directory exists
    ensureDefaultWorkspaceExists();

    // Only start the observer if onboarding is already done. If not, it will
    // be started by the 'onboarding-complete' IPC handler after the user
    // finishes or skips onboarding.
    if (isOnboardingComplete()) {
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
      const sensingPort = process.env.SENSING_PORT || '8080';
      const req = require('http').request(
        { hostname: '127.0.0.1', port: sensingPort, path: '/hotkey/capture', method: 'POST' },
        () => {}
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
