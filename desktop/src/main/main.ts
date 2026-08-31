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
  desktopCapturer,
  systemPreferences,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import axios from 'axios';
import { resolveHtmlPath } from './util';
import { DesktopAppUpdater } from './app-updater';
import { serviceManager, type ServiceFatalError } from './services/manager';
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
import {
  PersonalizationScheduler,
  type PersonalizationFatalError,
  type PersonalizationRunEvent,
} from './services/personalization-scheduler';
import { EveningPersonalizationScheduler } from './services/evening-personalization-scheduler';
import { DailyMemoryDraftService } from './services/daily-memory-drafts';
import { HiddenAvatarVisibility } from './services/hidden-avatar-visibility';
import { CocoGatewayClient } from './services/gateway-client';
import GatewayOutbox from './services/gateway-outbox';
import KnowledgeAnswerService, {
  registerKnowledgeAnswerIpcHandler,
} from './services/knowledge-answer-service';
import SocialBackgroundPoller from './services/social-background-poller';
import {
  SocialAvatarNotificationTracker,
  type SocialAvatarNotification,
} from './services/social-avatar-notifications';
import {
  registerSocialIpcHandlers,
  SocialService,
} from './services/social-service';
import { sanitizeFatalErrorMessage } from './services/fatal-error-telemetry';
import {
  clearAuthSession,
  readAuthSession,
  saveAuthSession,
} from './auth-session-store';
import {
  WakeWordService,
  type WakeWordStatusEvent,
} from './services/wake-word-service';
import {
  appendActivity,
  readActivity,
  recordSupportEngagement,
  recordSupportRating,
  recordSupportSuggestion,
  pruneActivity,
} from './activity-store';
import { readConversations, saveConversation } from './conversation-store';
import {
  defaultTutor,
  ensureManagedDefaultModelConfiguration,
  getModelConfigurationView,
  prepareModelConnectionTest,
  readModelConfiguration,
  resolveModelRuntime,
  resolveTutorRuntimeConnection,
  saveModelConfiguration,
  type ModelConfigurationInput,
  type ModelConnection,
} from './model-config-store';
import { ObservationSleepGuard } from './observation-sleep-guard';
import {
  cleanObservation,
  AI_TOOLS,
  resolveAiTools,
  parseAiTool,
  type InstantSuggestion as ReadyInstantSuggestion,
} from '../renderer/components/observation-types';

type GeneratedInstantSuggestion =
  | ReadyInstantSuggestion
  | (Omit<ReadyInstantSuggestion, 'kind'> & { kind: 'abstain' });
import type {
  ObservationStatus,
  AiToolButton,
  LLMCallMetrics,
} from '../renderer/components/observation-types';

const dotenv = require('dotenv');

type EmbeddedStudyConfig = { gatewayUrl?: string; routerUrl?: string };
// eslint-disable-next-line no-underscore-dangle
declare const __COCO_BUILD_STUDY_CONFIG__: EmbeddedStudyConfig | undefined;

const embeddedStudyConfig: EmbeddedStudyConfig =
  typeof __COCO_BUILD_STUDY_CONFIG__ === 'undefined'
    ? {}
    : __COCO_BUILD_STUDY_CONFIG__;

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
  if (!process.env.COCO_GATEWAY_URL && embeddedStudyConfig.gatewayUrl) {
    process.env.COCO_GATEWAY_URL = embeddedStudyConfig.gatewayUrl;
  }
  if (!process.env.LLM_ROUTER_URL && embeddedStudyConfig.routerUrl) {
    process.env.LLM_ROUTER_URL = embeddedStudyConfig.routerUrl;
  }
  // This experimental packaged build retains personalization screenshots by
  // default. An explicit value in the user's .env (especially `0`) wins.
  if (!(process.env.COLLECT_TRAINING_SCREENSHOTS ?? '').trim()) {
    process.env.COLLECT_TRAINING_SCREENSHOTS = '1';
  }
} else {
  // Dev: cwd is the desktop app dir, but the canonical .env (with GEMINI_API_KEY,
  // ANTHROPIC_API_KEY, etc.) lives at the repo root, one level up.
  // Load both — dotenv doesn't override pre-existing process.env entries, so
  // root-level keys win and desktop/.env supplies UI-only overrides.
  dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
  dotenv.config();
}

const trainingScreenshotRetentionEnabled = () =>
  ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECT_TRAINING_SCREENSHOTS ?? '').trim().toLowerCase(),
  );

const MAC_SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * Ask for the macOS permissions used by the sensing service before it begins
 * observing. Screen Recording has no `askForMediaAccess` API in Electron, so a
 * one-pixel, in-memory source lookup is used to trigger macOS's native consent
 * prompt; no image is retained. Accessibility has its own native prompt API.
 *
 * macOS only shows a native Screen Recording prompt once. When the user has
 * already denied it, take them directly to the relevant System Settings pane.
 */
const requestRequiredMacPermissions = async (): Promise<void> => {
  if (process.platform !== 'darwin' || !app.isPackaged) return;

  let screenRecordingStatus = systemPreferences.getMediaAccessStatus('screen');
  const accessibilityGranted =
    systemPreferences.isTrustedAccessibilityClient(false);

  log.info(
    `[Permissions] Accessibility=${accessibilityGranted ? 'granted' : 'missing'} ` +
      `ScreenRecording=${screenRecordingStatus}`,
  );

  if (screenRecordingStatus === 'not-determined') {
    log.info('[Permissions] Requesting Screen Recording access.');
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
    } catch (error) {
      log.warn('[Permissions] Screen Recording request failed:', error);
    }
    screenRecordingStatus = systemPreferences.getMediaAccessStatus('screen');
    log.info(
      `[Permissions] Screen Recording after request=${screenRecordingStatus}`,
    );
  }

  if (screenRecordingStatus !== 'granted') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Allow Coco to see your screen',
      message: 'Coco needs Screen Recording access',
      detail:
        'Coco uses this access to understand what is on screen and provide proactive support. ' +
        'Enable Coco under Privacy & Security → Screen Recording, then quit and reopen Coco.',
      buttons: ['Open System Settings', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS);
      // Do not stack the Accessibility prompt on top of System Settings. It
      // will be checked again the next time Coco launches.
      return;
    }
  }

  if (!accessibilityGranted) {
    log.warn('[Permissions] Requesting Accessibility access.');
    // Passing true asks macOS to show its native prompt, whose action opens
    // Privacy & Security → Accessibility. The permission takes effect after
    // Coco is reopened, when the sensing-server input listeners are recreated.
    systemPreferences.isTrustedAccessibilityClient(true);
  }
};

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

let installUpdateAfterShutdown = false;
const desktopAppUpdater = new DesktopAppUpdater({
  updater: autoUpdater,
  logger: log,
  isPackaged: app.isPackaged,
  platform: process.platform,
  currentVersion: () => app.getVersion(),
  requestRestartAndInstall: () => {
    installUpdateAfterShutdown = true;
    app.quit();
  },
});

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
let imagePreviewEditable = false;
let imagePreviewSourceWindow: BrowserWindow | null = null;
let imagePreviewAnnotationResult: 'replace' | 'attach' = 'replace';
let imagePreviewFullScreenOverlay = false;
let hotkeyCaptureInProgress = false;
let wakeWordCaptureWindow: BrowserWindow | null = null;
let notificationWindow: BrowserWindow | null = null;
let notificationHovered = false;
let revealedSuggestionOpen = false;
let proactiveNotificationOpen = false;
// The newest proactive event eligible for presentation, regardless of whether
// it will use the avatar bubble or the hidden-avatar notification surface.
// Tutor requests may finish out of order, so only this id may be shown.
let latestProactiveSuggestionObservationId: string | undefined;
let onboardingWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
let sessionSetupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let hideAvatarMode = false;
let avatarRendererReady = false;
let avatarDragOffset: { x: number; y: number } | null = null;
let pendingOpenHistory = false;
let pendingOpenSocialInbox = false;
let pendingSocialAvatarNotification: SocialAvatarNotification | null = null;
let revealSocialAvatarNotification:
  | ((notification: SocialAvatarNotification) => void)
  | null = null;
const hiddenAvatarVisibility = new HiddenAvatarVisibility();
const observationSleepGuard = new ObservationSleepGuard();
let personalizationScheduler: PersonalizationScheduler | null = null;
let eveningPersonalizationScheduler: EveningPersonalizationScheduler | null =
  null;
let wakeAfterEveningPersonalization = false;
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

let wakeWordService: WakeWordService | null = null;
const DEFAULT_WAKE_WORD_ENABLED = true;
let wakeWordEnabled = DEFAULT_WAKE_WORD_ENABLED;
let wakeWordStatus: WakeWordStatusEvent = { status: 'disabled' };
let systemSuspended = false;
let wakeWordCapturePaused = false;
let wakeWordCapturePauseTimer: ReturnType<typeof setTimeout> | null = null;
let wakeWordCaptureState = 'stopped';
let wakeWordDetectionSequence = 0;
let pendingWakeWordDetection: {
  id: number;
  keyword: string;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
} | null = null;

const WAKE_WORDS = ['COCO', 'HI COCO', 'HEY COCO'] as const;
const WAKE_WORD_MODEL =
  'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

const wakeWordSettingsPath = () =>
  path.join(app.getPath('userData'), 'wake-word.json');

const readWakeWordEnabled = (): boolean => {
  const settingsPath = wakeWordSettingsPath();
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      enabled?: unknown;
    };
    if (typeof saved?.enabled !== 'boolean') {
      throw new Error('saved enabled value is missing or invalid');
    }
    const { enabled } = saved;
    log.info(`[Wake word] Loaded enabled=${enabled} from ${settingsPath}`);
    return enabled;
  } catch (error) {
    log.info(
      `[Wake word] No saved setting at ${settingsPath}; defaulting enabled (${(error as Error).message})`,
    );
    return DEFAULT_WAKE_WORD_ENABLED;
  }
};

const saveWakeWordEnabled = (enabled: boolean): void => {
  fs.writeFileSync(
    wakeWordSettingsPath(),
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    'utf8',
  );
};

const publishWakeWordStatus = (status: WakeWordStatusEvent): void => {
  wakeWordStatus = status;
  chatWindow?.webContents.send('wake-word-status', status);
  if (status.detail) log.warn(`[Wake word] ${status.status}: ${status.detail}`);
  else log.info(`[Wake word] ${status.status}`);
};

const setWakeWordCapturePaused = (paused: boolean): void => {
  wakeWordCapturePaused = paused;
  if (wakeWordCapturePauseTimer) clearTimeout(wakeWordCapturePauseTimer);
  wakeWordCapturePauseTimer = null;
  wakeWordCaptureWindow?.webContents.send('wake-word-capture-paused-changed', {
    paused,
  });
  if (paused) {
    // Voice recording is capped at 30 seconds. Never leave activation paused
    // indefinitely if the chat renderer fails during the handoff.
    wakeWordCapturePauseTimer = setTimeout(() => {
      setWakeWordCapturePaused(false);
    }, 45_000);
  }
};

// Completed hot-key screen captures waiting to be shown as preview thumbnails
// in the chat input bar. The direct annotation overlay can finish before a fresh
// chat renderer has mounted its IPC listener, so buffer here and flush once the
// renderer announces it is ready.
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
const profilePath = () =>
  path.join(app.getPath('userData'), 'coco-profile.json');

const isOnboardingComplete = (): boolean => {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf-8');
    const profile = JSON.parse(raw);
    return (
      profile?.onboardingComplete === true &&
      (!gatewayClient ||
        (Boolean(currentUserId) && profile?.participantId === currentUserId))
    );
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
const appRunId = randomUUID();
let currentUserId = process.env.COCO_GATEWAY_USER_ID?.trim() || null;
let isAuthenticated = false;
let pendingAuthLaunch: 'signin' | 'signup' | null = null;
let gatewayClient: CocoGatewayClient | null = null;
let gatewayOutbox: GatewayOutbox | null = null;
let telemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
const socialService = new SocialService(() => gatewayClient);
const knowledgeAnswerService = new KnowledgeAnswerService(readLocalMemory);
const socialAvatarNotificationTracker = new SocialAvatarNotificationTracker();
const socialBackgroundPoller = new SocialBackgroundPoller(
  socialService,
  (snapshot) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('social-inbox-updated', snapshot);
    }
    const notification = socialAvatarNotificationTracker.next(snapshot);
    const chatOpen =
      chatWindow !== null &&
      !chatWindow.isDestroyed() &&
      chatWindow.isVisible();
    if (notification && !chatOpen) {
      revealSocialAvatarNotification?.(notification);
    }
  },
  log,
);
const endedGatewaySessions = new Set<string>();
const gatewayExposureIds = new Map<string, string>();
let currentSessionId: string | null = null;
let pendingTaskLabel: string | null = null;
let currentTutorModelId: string | null = null;
// Invite timing is owned by the sensing-side judge; no renderer-side cooldown.

const queueGatewayOperation = (
  type:
    | 'session_start'
    | 'session_end'
    | 'message'
    | 'interaction_batch'
    | 'fatal_error'
    | 'personalization_run',
  payload: Record<string, unknown>,
) => {
  if (!gatewayOutbox) return;
  gatewayOutbox.enqueue(type, payload);
};

type FatalService = 'observer' | 'tutor' | 'personalization';

const configuredModelForFatalError = (
  service: FatalService,
): string | undefined => {
  if (service === 'observer' || service === 'personalization') {
    const config = resolveModelRuntime()?.config;
    return (
      config?.sensing.model || process.env.OBSERVER_MODEL?.trim() || undefined
    );
  }
  const selected = resolveTutorRuntimeConnection(currentTutorModelId);
  return selected?.model || process.env.TUTOR_MODEL?.trim() || undefined;
};

const queueFatalError = (
  service: FatalService,
  error: {
    failureType: 'spawn_error' | 'unexpected_exit';
    message: string;
    exitCode?: number;
    signal?: string;
    restartScheduled?: boolean;
    restartAttempt?: number;
    job?: 'signals' | 'revise' | 'evolve';
  },
): void => {
  const model = configuredModelForFatalError(service);
  let modelEnvironment: Record<string, string> = {};
  try {
    const runtime = resolveModelRuntime();
    modelEnvironment = {
      ...runtime?.sensingEnv,
      ...runtime?.tutorEnv,
    };
  } catch {
    // A broken model configuration may be the failure being reported. Generic
    // pattern redaction still runs when the credentials cannot be read.
  }
  queueGatewayOperation('fatal_error', {
    _id: randomUUID(),
    occurred_at: new Date().toISOString(),
    service,
    failure_type: error.failureType,
    message: sanitizeFatalErrorMessage(error.message, [
      process.env,
      modelEnvironment,
    ]),
    app_run_id: appRunId,
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ...(currentSessionId ? { session_id: currentSessionId } : {}),
    ...(model ? { model } : {}),
    ...(typeof error.exitCode === 'number'
      ? { exit_code: error.exitCode }
      : {}),
    ...(error.signal ? { signal: error.signal } : {}),
    ...(typeof error.restartScheduled === 'boolean'
      ? { restart_scheduled: error.restartScheduled }
      : {}),
    ...(typeof error.restartAttempt === 'number'
      ? { restart_attempt: error.restartAttempt }
      : {}),
    ...(error.job ? { job: error.job } : {}),
  });
};

const queuePersonalizationRunEvent = (event: PersonalizationRunEvent): void => {
  const model = configuredModelForFatalError('personalization');
  queueGatewayOperation('personalization_run', {
    _id: randomUUID(),
    run_id: event.runId,
    occurred_at: new Date(event.occurredAt).toISOString(),
    started_at: new Date(event.startedAt).toISOString(),
    job: event.job,
    state: event.state,
    app_run_id: appRunId,
    app_version: app.getVersion(),
    ...(model ? { model } : {}),
    ...(typeof event.durationMs === 'number'
      ? { duration_ms: event.durationMs }
      : {}),
    ...(typeof event.exitCode === 'number'
      ? { exit_code: event.exitCode }
      : {}),
    ...(event.signal ? { signal: event.signal } : {}),
  });
};

const fatalServiceById: Record<
  string,
  Exclude<FatalService, 'personalization'>
> = {
  'sensing-server': 'observer',
  'tutor-server': 'tutor',
};

serviceManager.setFatalErrorHandler((error: ServiceFatalError) => {
  const service = fatalServiceById[error.serviceId];
  if (!service) return;
  queueFatalError(service, error);
});

const gatewayInteractionKinds = new Set([
  'shown',
  'revealed',
  'engage',
  'dismiss',
  'auto_hidden',
  'need_help',
  'thumbs_up',
  'thumbs_down',
  'copy',
  'open_tool',
  'chat_about',
]);
const gatewayInteractionSurfaces = new Set([
  'bubble',
  'notification',
  'history',
  'chat',
  'session_prompt',
]);

/** Store only the explicit interaction metadata accepted by the study API. */
const queueGatewayInteraction = (payload: unknown): void => {
  if (!gatewayOutbox || !payload || typeof payload !== 'object') return;
  const source = payload as Record<string, unknown>;
  const kind = typeof source.kind === 'string' ? source.kind : '';
  const surface = typeof source.surface === 'string' ? source.surface : '';
  if (
    !gatewayInteractionKinds.has(kind) ||
    !gatewayInteractionSurfaces.has(surface)
  ) {
    return;
  }
  const stringField = (name: string): string | undefined =>
    typeof source[name] === 'string' && source[name]
      ? (source[name] as string)
      : undefined;
  const numberField = (name: string): number | undefined =>
    typeof source[name] === 'number' &&
    Number.isFinite(source[name]) &&
    (source[name] as number) >= 0
      ? (source[name] as number)
      : undefined;
  const observationId = stringField('observation_id');
  const messageId = stringField('message_id');
  const status = stringField('status');
  const sessionId = stringField('session_id') || currentSessionId || undefined;
  const exposureSubject = observationId || messageId || status;
  const exposureKey = exposureSubject
    ? `${surface}:${exposureSubject}`
    : undefined;
  if (kind === 'shown' && exposureKey) {
    gatewayExposureIds.set(exposureKey, randomUUID());
  }
  const exposureId = exposureKey
    ? gatewayExposureIds.get(exposureKey) ||
      `${appRunId}:${surface}:${exposureSubject}`
    : undefined;
  const previousKind = stringField('previous_kind');
  const event = {
    _id: randomUUID(),
    occurred_at: new Date().toISOString(),
    kind,
    surface,
    app_run_id: appRunId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(exposureId ? { exposure_id: exposureId } : {}),
    ...(observationId ? { observation_id: observationId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    ...(stringField('suggestion_id')
      ? { suggestion_id: stringField('suggestion_id') }
      : {}),
    ...(status ? { status } : {}),
    ...(source.stage === 'offer' || source.stage === 'revealed'
      ? { stage: source.stage }
      : {}),
    ...(source.destination === 'inline' || source.destination === 'conversation'
      ? { destination: source.destination }
      : {}),
    ...(previousKind === 'thumbs_up' || previousKind === 'thumbs_down'
      ? { previous_kind: previousKind }
      : {}),
    ...(numberField('latency_s') !== undefined
      ? { latency_s: numberField('latency_s') }
      : {}),
    ...(stringField('tool_id') ? { tool_id: stringField('tool_id') } : {}),
  };
  // Deliberately do not forward `text` or raw observations. The Gateway's
  // interaction collection contains behavioral metadata, not sensed content.
  queueGatewayOperation('interaction_batch', { events: [event] });
};

const queueGatewayMessage = (payload: Record<string, unknown>): void => {
  if (!currentSessionId) return;
  queueGatewayOperation('message', {
    ...payload,
    sid: currentSessionId,
  });
};

const requestedPort = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
};

const requestedPersonalizationConcurrency = (
  value: string | undefined,
): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : 4;
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
  if (!excluded.has(preferred) && (await canBindPort(preferred)))
    return preferred;
  for (let candidate = 49152; candidate <= 65535; candidate += 1) {
    if (!excluded.has(candidate) && (await canBindPort(candidate)))
      return candidate;
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
  serviceManager.configureServiceArg(
    'sensing-server',
    'port',
    String(sensingPort),
  );
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

// Authentication is completed before onboarding or any sensing/model service
// starts, so every remotely stored record belongs to a verified participant.
const createAuthWindow = () => {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    authWindow.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const width = 476;
  const height = 650;
  authWindow = new BrowserWindow({
    show: false,
    x: Math.round((sw - width) / 2),
    y: Math.round((sh - height) / 2),
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: process.platform !== 'darwin',
    webPreferences: { preload: preloadPath() },
  });
  authWindow.loadURL(`${resolveHtmlPath('index.html')}?view=auth`);
  authWindow.on('ready-to-show', () => authWindow?.show());
  authWindow.on('closed', () => {
    authWindow = null;
  });
  authWindow.on('close', (event) => {
    if (isQuitting || isAuthenticated) return;
    event.preventDefault();
    authWindow?.hide();
    createTray();
  });
};

function syncHiddenAvatarWindowVisibility(): void {
  if (
    !hideAvatarMode ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }
  if (hiddenAvatarVisibility.shouldShowWindow()) {
    avatarWindow.show();
  } else {
    avatarWindow.hide();
  }
}

function dismissSocialAvatarNotification(): void {
  pendingSocialAvatarNotification = null;
  hiddenAvatarVisibility.setVisible('social-notification', false);
  syncHiddenAvatarWindowVisibility();
}

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
  }${process.env.LLM_ROUTER_API_KEY ? '&routerManaged=1' : ''}`;
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
      syncHiddenAvatarWindowVisibility();
    } else if (process.env.START_MINIMIZED) {
      avatarWindow?.minimize();
    } else {
      avatarWindow?.show();
    }
  });

  avatarWindow.on('closed', () => {
    avatarWindow = null;
    avatarRendererReady = false;
    hiddenAvatarVisibility.clear();
  });

  avatarWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Native drag regions do not reliably dispatch DOM context-menu events. Use
  // Electron's native hooks, then ask the renderer to reveal the same menu as
  // the ellipsis button so both entry points stay visually and functionally
  // consistent.
  const revealActionsMenu = () => {
    avatarWindow?.webContents.send('open-avatar-actions-menu');
  };
  avatarWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
    revealActionsMenu();
  });
  avatarWindow.on('system-context-menu', (event) => {
    event.preventDefault();
    revealActionsMenu();
  });

  // (notification is screen-pinned; no need to reposition on move)
};

revealSocialAvatarNotification = (notification) => {
  pendingSocialAvatarNotification = notification;
  hiddenAvatarVisibility.setVisible('social-notification', true);
  createAvatarWindow();
  syncHiddenAvatarWindowVisibility();
  if (!avatarWindow || avatarWindow.isDestroyed() || !avatarRendererReady) {
    return;
  }
  avatarWindow.webContents.send('social-avatar-notification', notification);
  pendingSocialAvatarNotification = null;
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
    webPreferences: { preload: preloadPath(), backgroundThrottling: false },
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
        chatContentZoomFactor =
          CHAT_CONTENT_ZOOM_LEVELS[
          Math.min(currentIndex + 1, CHAT_CONTENT_ZOOM_LEVELS.length - 1)
        ];
      } else {
        chatContentZoomFactor =
          CHAT_CONTENT_ZOOM_LEVELS[Math.max(currentIndex - 1, 0)];
      }
      reportChatContentZoom();
    }
  });
  chatWindow.webContents.on('did-finish-load', () => {
    chatWindow?.webContents.setZoomFactor(1);
    reportChatContentZoom();
    const socialSnapshot = socialBackgroundPoller.latestSnapshot();
    if (socialSnapshot) {
      chatWindow?.webContents.send('social-inbox-updated', socialSnapshot);
    }
  });

  // Closing hides rather than destroys so the in-memory conversation survives
  // a reopen. On a real app quit, let it close so shutdown isn't blocked.
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

  chatWindow.on('closed', () => {
    chatWindow = null;
  });

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

  // Once chat is visible, the social inbox is directly accessible and no
  // longer needs to keep a hidden avatar temporarily revealed.
  dismissSocialAvatarNotification();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send('dismiss-social-avatar-notification');
  }

  // Chat is already the user's active support surface. Cancel suggestions that
  // have not been revealed yet and prevent an in-flight hidden-avatar request
  // from surfacing after the chat opens. A suggestion the user explicitly
  // revealed remains pinned until they close it themselves.
  latestProactiveSuggestionObservationId = undefined;
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send('suppress-unrevealed-proactive-suggestion');
  }
  if (
    proactiveNotificationOpen &&
    !revealedSuggestionOpen &&
    notificationWindow &&
    !notificationWindow.isDestroyed()
  ) {
    notificationWindow.destroy();
  }
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

const isChatPanelOpen = (): boolean =>
  chatWindow !== null && !chatWindow.isDestroyed() &&
  chatWindow.isVisible();

function openSocialInbox(): void {
  pendingOpenSocialInbox = true;
  dismissSocialAvatarNotification();
  showChatPanel();
  if (
    chatWindow &&
    !chatWindow.isDestroyed() &&
    hotkeyRendererReady
  ) {
    pendingOpenSocialInbox = false;
    chatWindow.webContents.send('open-social-inbox');
  }
}

const clearImagePreviewState = (target: BrowserWindow) => {
  if (imagePreviewWindow !== target) return;
  imagePreviewWindow = null;
  imagePreviewDataUrl = null;
  imagePreviewEditable = false;
  imagePreviewSourceWindow = null;
  imagePreviewAnnotationResult = 'replace';
  imagePreviewFullScreenOverlay = false;
};

const dismissImagePreviewWindow = (target: BrowserWindow) => {
  clearImagePreviewState(target);
  if (!target.isDestroyed()) target.destroy();
};

const captureDisplayAtCursor = async (): Promise<string> => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const pixelSize = {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: pixelSize,
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : undefined);
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
};

const openImagePreviewWindow = (
  sourceWindow: BrowserWindow | null,
  imageDataUrl: string,
  editable = false,
  annotationResult: 'replace' | 'attach' = 'replace',
  displayAtCursor = false,
  fullScreenOverlay = false,
) => {
  imagePreviewDataUrl = imageDataUrl;
  imagePreviewEditable = editable;
  imagePreviewSourceWindow = sourceWindow;
  imagePreviewAnnotationResult = annotationResult;
  imagePreviewFullScreenOverlay = fullScreenOverlay;
  const display =
    sourceWindow && !displayAtCursor
      ? screen.getDisplayMatching(sourceWindow.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
    if (
      process.platform === 'darwin' &&
      imagePreviewWindow.isSimpleFullScreen()
    ) {
      imagePreviewWindow.setSimpleFullScreen(false);
    }
    imagePreviewWindow.setBounds(display.bounds);
    if (process.platform === 'darwin') {
      imagePreviewWindow.setSimpleFullScreen(true);
    }
    if (!imagePreviewWindow.webContents.isLoadingMainFrame()) {
      imagePreviewWindow.webContents.send('image-preview', {
        imageDataUrl,
        editable,
        fullScreenOverlay,
      });
      imagePreviewWindow.show();
      imagePreviewWindow.focus();
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
    webPreferences: { preload: preloadPath() },
  });
  imagePreviewWindow = previewWindow;
  previewWindow.setAlwaysOnTop(
    true,
    process.platform === 'darwin' ? 'screen-saver' : 'floating',
  );
  if (process.platform === 'darwin') {
    // A bounded frameless window is constrained below macOS's live menu bar,
    // which leaves the captured menu bar visible underneath it. Simple
    // fullscreen covers the menu bar and Dock without creating a new Space.
    previewWindow.setSimpleFullScreen(true);
  }
  previewWindow.loadURL(`${resolveHtmlPath('index.html')}?view=image-preview`);
  previewWindow.on('closed', () => {
    // A rapid cancel → hotkey sequence can create the next preview before the
    // old window emits `closed`. Never let the old callback clear the new one.
    clearImagePreviewState(previewWindow);
  });
};

const beginHotkeyCapture = async (): Promise<void> => {
  if (hotkeyCaptureInProgress) {
    log.info('[ImagePreview] Capture already in progress; ignoring repeat.');
    return;
  }
  if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
    imagePreviewWindow.show();
    imagePreviewWindow.focus();
    return;
  }

  hotkeyCaptureInProgress = true;
  const startedAt = Date.now();
  try {
    const dataUrl = await captureDisplayAtCursor();
    createChatWindow();
    openImagePreviewWindow(chatWindow, dataUrl, true, 'attach', true, true);
    log.info(
      `[ImagePreview] Annotation overlay opened in ${Date.now() - startedAt}ms.`,
    );
  } catch (error) {
    log.error(
      `[ImagePreview] Direct screenshot capture failed: ${(error as Error).message}`,
    );
  } finally {
    hotkeyCaptureInProgress = false;
  }
};

const deliverPendingWakeWordDetection = (): void => {
  const pending = pendingWakeWordDetection;
  if (!pending) return;
  if (pending.attempts >= 30) {
    log.warn(
      `[Wake word] Chat did not acknowledge detection ${pending.id}; resuming listening`,
    );
    pendingWakeWordDetection = null;
    setWakeWordCapturePaused(false);
    return;
  }
  pending.attempts += 1;
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('wake-word-detected', {
      id: pending.id,
      keyword: pending.keyword,
    });
  }
  pending.retryTimer = setTimeout(deliverPendingWakeWordDetection, 500);
};

const queueWakeWordDetection = (keyword: string): void => {
  if (pendingWakeWordDetection?.retryTimer) {
    clearTimeout(pendingWakeWordDetection.retryTimer);
  }
  wakeWordDetectionSequence += 1;
  pendingWakeWordDetection = {
    id: wakeWordDetectionSequence,
    keyword,
    attempts: 0,
    retryTimer: null,
  };
  setWakeWordCapturePaused(true);
  showChatPanel();
  deliverPendingWakeWordDetection();
};

const createWakeWordCaptureWindow = (): void => {
  if (wakeWordCaptureWindow && !wakeWordCaptureWindow.isDestroyed()) return;
  const { x, y } = screen.getPrimaryDisplay().workArea;
  wakeWordCaptureWindow = new BrowserWindow({
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
      preload: preloadPath(),
      backgroundThrottling: false,
    },
  });
  wakeWordCaptureWindow.setIgnoreMouseEvents(true);
  wakeWordCaptureWindow.setAlwaysOnTop(true, 'floating');
  wakeWordCaptureWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  wakeWordCaptureWindow.loadURL(
    `${resolveHtmlPath('index.html')}?view=wake-word-capture`,
  );
  wakeWordCaptureWindow.webContents.on(
    'render-process-gone',
    (_event, details) => {
      log.error(
        `[Wake word] Capture renderer exited: ${details.reason} (${details.exitCode})`,
      );
    },
  );
  wakeWordCaptureWindow.on('closed', () => {
    wakeWordCaptureWindow = null;
  });
};

const syncWakeWordService = (): void => {
  if (!wakeWordService) return;
  if (!wakeWordEnabled) wakeWordService.stop('disabled');
  else if (isCocoSleeping() || systemSuspended) {
    wakeWordService.stop('sleeping');
  } else wakeWordService.start();
};

const initializeWakeWordService = (): void => {
  if (wakeWordService) return;
  wakeWordEnabled = readWakeWordEnabled();
  const modelDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'wake-word', WAKE_WORD_MODEL)
    : path.resolve(process.cwd(), 'assets', 'wake-word', WAKE_WORD_MODEL);
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
  wakeWordService = new WakeWordService({
    projectRoot: app.isPackaged
      ? process.resourcesPath
      : path.resolve(process.cwd(), '..'),
    modelDir,
    stateDir: path.join(app.getPath('userData'), 'wake-word'),
    logPath: path.join(app.getPath('userData'), 'logs', 'wake-word.log'),
    packagedExecutable: executable,
    onStatus: publishWakeWordStatus,
    onDetected: (keyword) => {
      if (!wakeWordEnabled || isCocoSleeping() || systemSuspended) return;
      log.info(`[Wake word] Detected ${keyword}`);
      queueWakeWordDetection(keyword);
    },
  });
  syncWakeWordService();
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

ipcMain.removeAllListeners('quit-app');
ipcMain.on('quit-app', () => app.quit());

async function openCoco(): Promise<void> {
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '');
    return;
  }
  const problemStatement = pendingTaskLabel || 'General help session';
  await createProactiveTutorSession(problemStatement, 120, undefined, 'manual');
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
    Menu.buildFromTemplate(
      pendingSetup
        ? [
            {
              label: isOnboardingComplete()
                ? 'Open Model Setup'
                : 'Continue Setup',
              click: openPrimaryTrayAction,
            },
            ...(desktopAppUpdater.isSupported()
              ? [
                  {
                    label: 'Check for Updates…',
                    click: () => {
                      desktopAppUpdater.checkForUpdates(true).catch((error) =>
                        log.error(
                          `[Updater] Manual update check failed: ${error}`,
                        ),
                      );
                    },
                  },
                ]
              : []),
            { type: 'separator' },
            { label: 'Quit', click: () => app.quit() },
          ]
        : [
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
            ...(desktopAppUpdater.isSupported()
              ? [
                  {
                    label: 'Check for Updates…',
                    click: () => {
                      desktopAppUpdater.checkForUpdates(true).catch((error) =>
                        log.error(
                          `[Updater] Manual update check failed: ${error}`,
                        ),
                      );
                    },
                  },
                ]
              : []),
            { type: 'separator' },
            { label: 'Quit', click: () => app.quit() },
          ],
    ),
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
    // Keep the renderer alive while hidden so its midnight timer can discover
    // a new daily memory draft and reveal only the review surface.
    createAvatarWindow();
    syncHiddenAvatarWindowVisibility();
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

  sessionSetupWindow.on('closed', () => {
    sessionSetupWindow = null;
  });
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

type NotificationPayload = {
  message: string;
  actionLabel: string;
  vizState?: VizState;
  notifType?: NotifType;
  cancelLabel?: string;
  observationId?: string;
  status?: string;
  rawObservation?: string;
  suggestion?: ReadyInstantSuggestion;
  /** Preserve important lifecycle messages until the current card is closed. */
  deferIfBusy?: boolean;
};

let deferredNotificationPayload: NotificationPayload | null = null;

const hasOpenRevealedSuggestion = (): boolean =>
  revealedSuggestionOpen &&
  notificationWindow !== null &&
  !notificationWindow.isDestroyed();

const showNotification = (payload: NotificationPayload): boolean => {
  if (payload.notifType !== 'proactive-suggestion') {
    latestProactiveSuggestionObservationId = undefined;
  }
  if (payload.notifType === 'proactive-suggestion' && isChatPanelOpen()) {
    latestProactiveSuggestionObservationId = undefined;
    log.info(
      '[Notification] Suppressed proactive suggestion while Coco chat is open.',
    );
    return false;
  }
  if (hasOpenRevealedSuggestion()) {
    if (payload.notifType === 'proactive-suggestion') {
      log.info(
        '[Notification] Suppressed proactive suggestion while a revealed suggestion is open.',
      );
    } else {
      deferredNotificationPayload = payload;
      log.info(
        '[Notification] Deferred notification until the revealed suggestion is closed.',
      );
    }
    return false;
  }
  if (
    notificationHovered &&
    notificationWindow &&
    !notificationWindow.isDestroyed()
  ) {
    if (payload.deferIfBusy) deferredNotificationPayload = payload;
    log.info(
      `[Notification] Keeping hovered notification; ${
        payload.deferIfBusy ? 'deferring' : 'dropping'
      } replacement.`,
    );
    return false;
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
  proactiveNotificationOpen = payload.notifType === 'proactive-suggestion';
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
    revealedSuggestionOpen = false;
    proactiveNotificationOpen = false;
    const deferredPayload = deferredNotificationPayload;
    deferredNotificationPayload = null;
    if (deferredPayload && !isQuitting && !systemSuspended) {
      setImmediate(() => showNotification(deferredPayload));
    }
  });

  return true;
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
    const profile = JSON.parse(raw);
    return {
      ...profile,
      ...(currentUserId ? { participantId: currentUserId } : {}),
    };
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
  status: 'verified' | 'failed' | 'legacy_unassessed' | 'not_configured';
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
    // Sleep mode intentionally stops sensing. Avoid reporting the observer's
    // expected absence as a health failure; text chat remains available.
    if (isCocoSleeping()) {
      return { checkedAt: Date.now(), sleeping: true };
    }
  type ModelAssessment = {
    status: ModelHealthAssessment['status'];
    detail: string;
  };
  const savedConfig = readModelConfiguration();
  const assessModelConfiguration = async (
    role: 'sensing' | 'tutor',
  ): Promise<ModelAssessment> => {
      const connection =
        role === 'sensing'
      ? savedConfig?.sensing
          : (savedConfig?.tutors.find(
              (item) => item.id === currentTutorModelId,
            ) ??
            savedConfig?.tutors.find(
              (item) => item.id === savedConfig.defaultTutorId,
            ));
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
      const legacyModel =
        role === 'sensing'
      ? process.env.OBSERVER_MODEL
      : process.env.TUTOR_MODEL;
    if (legacyModel?.trim()) {
      return {
        status: 'legacy_unassessed',
          detail:
            'Model uses environment settings and cannot be assessed here.',
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
    const prepared = prepareModelConnectionTest(connection, role, apiKey ?? '');
      const providerEnvNames = new Set([
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'OPENAI_API_KEY',
        'NV_INFERENCE_API_KEY',
        'NV_INFERENCE_BASE_URL',
        'TINKER_API_KEY',
        'TINKER_BASE_URL',
        'TINFOIL_API_KEY',
        'HOSTED_VLLM_API_KEY',
        'HOSTED_VLLM_API_BASE',
        'LLM_ROUTER_URL',
        'LLM_ROUTER_API_KEY',
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
    const rawError =
      parsed?.error || result.stderr.trim() || 'Connection failed.';
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
  const { aiTools, scenario, customObserverPrompt, userName } = readProfile();
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
  await axios.post(
    `${tutor}/context/user_name`,
    { user_name: userName },
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
        personalizationScheduler?.updateModelConfiguration(
          runtime.config.sensing.model,
          runtime.sensingEnv,
        );
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
      log.warn(
        `[Models] Could not save configuration: ${(err as Error).message}`,
      );
      return { success: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'set-chat-model',
  async (_event, { modelId }: { modelId?: string } = {}) => {
    const selected = resolveTutorRuntimeConnection(modelId, {
      fallbackToDefault: false,
    });
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
    fs.writeFileSync(
      profilePath(),
      JSON.stringify(
        { ...profile, ...(currentUserId ? { participantId: currentUserId } : {}) },
        null,
        2,
      ),
      'utf-8',
    );
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
    fs.writeFileSync(
      profilePath(),
      JSON.stringify(
        { ...profile, ...(currentUserId ? { participantId: currentUserId } : {}) },
        null,
        2,
      ),
      'utf-8',
    );
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
// what lets a saved annotation open the chat and attach reliably.
ipcMain.removeAllListeners('hotkey-capture-ready');
ipcMain.on('hotkey-capture-ready', () => {
  hotkeyRendererReady = true;
  flushHotkeyCaptures();
  if (pendingOpenSocialInbox && chatWindow && !chatWindow.isDestroyed()) {
    pendingOpenSocialInbox = false;
    chatWindow.webContents.send('open-social-inbox');
  }
});

// Pet click / "open chat". If a session is already active, reopen its chat
// panel; otherwise start a fresh local session so there is a conversation to
// show (the sensing observer keeps running either way).
ipcMain.removeAllListeners('open-main-window');
ipcMain.on('open-main-window', () => {
  openCoco().catch((err) => log.warn(`[Chat] Could not open Coco: ${err}`));
});

ipcMain.removeAllListeners('open-social-inbox');
ipcMain.on('open-social-inbox', () => openSocialInbox());

ipcMain.removeAllListeners('social-avatar-notification-closed');
ipcMain.on('social-avatar-notification-closed', () => {
  dismissSocialAvatarNotification();
});

// "Help me with this" on a proactive bubble.
//   • Active session  → open the chat panel and inject the observation as a new
//     message into the existing conversation.
//   • No active session → this IS accepting the invite: create a tutor session
//     seeded with what the user was doing, then inject the observation as the
//     first message once the chat panel has loaded.
ipcMain.removeAllListeners('help-me-with-this');
ipcMain.on(
  'help-me-with-this',
  async (
    _event,
    payload: { phrase: string; label: string; rawObservation: string },
  ) => {
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '', payload);
    return;
  }

  // Pre-session: create a session, then inject the observation once it loads.
  const problemStatement =
      payload?.phrase?.trim() ||
      payload?.label?.trim() ||
      pendingTaskLabel ||
      'General help session';
    const sessionId = await createProactiveTutorSession(
      problemStatement,
      120,
      payload,
      'proactive_suggestion',
    );
  if (!sessionId) {
      log.warn(
        '[Chat] Could not start a local tutor session for help-me-with-this.',
      );
  }
  },
);

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
    queueGatewayInteraction({
      kind: 'engage',
      surface: 'notification',
      observation_id: observationId,
      status,
      destination: 'conversation',
    });
    const sensingPort = process.env.SENSING_PORT || '8080';
    axios
      .post(
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
        'proactive_suggestion',
      );
    }
  },
);

// Forward an explicit user reaction (bubble engage/dismiss) to the sensing
// server's /feedback endpoint, which logs it into the shared training data.
ipcMain.removeAllListeners('training-feedback');
ipcMain.on('training-feedback', async (_event, payload) => {
  queueGatewayInteraction(payload);
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

async function setCocoSleepMode(
  sleeping: boolean,
  { wakeAfterPersonalization = false } = {},
) {
  if (!personalizationScheduler && !isDailyMemoryPreviewOnly()) {
    return { success: false, error: 'Personalization is not ready.' };
  }
  wakeAfterEveningPersonalization = wakeAfterPersonalization;
  try {
    if (sleeping && personalizationScheduler) {
      // Make sleep authoritative before stopping services so a concurrent
      // health request cannot misclassify their intentional shutdown.
      personalizationScheduler.setSleepMode(true);
      // Sleep pauses observation but deliberately keeps the tutor alive. This
      // lets the user continue chatting while Coco-PE uses the quiet period.
      await serviceManager.stopService('sensing-server');
      serviceManager.startService('tutor-server');
    } else if (personalizationScheduler) {
      personalizationScheduler.setSleepMode(false);
      serviceManager.startAll();
    }
  } catch (error) {
    if (wakeAfterPersonalization) wakeAfterEveningPersonalization = false;
    throw error;
  }
  previewCocoSleepMode = sleeping;
  syncWakeWordService();
  avatarWindow?.webContents.send('coco-sleep-mode-changed', { sleeping });
  chatWindow?.webContents.send('coco-sleep-mode-changed', { sleeping });
  wakeWordCaptureWindow?.webContents.send('coco-sleep-mode-changed', {
    sleeping,
  });
  if (!sleeping) {
    avatarWindow?.webContents.send('daily-memory-draft-refresh');
  }
  if (tray && !tray.isDestroyed()) createTray();
  return { success: true, sleeping };
}

async function requestDailyMemoryReview(attempt = 0): Promise<string> {
  const tutorPort = process.env.TUTOR_PORT || '8081';
  try {
    const response = await axios.post(
      `http://127.0.0.1:${tutorPort}/review/daily`,
      {},
      { timeout: 2 * 60_000 },
    );
    return String(
      (response.data as { guidance?: unknown } | undefined)?.guidance ?? '',
    ).trim();
  } catch (error) {
    // At launch, the evening check can race the tutor subprocess becoming
    // healthy. Give it a short readiness window before using fallback copy.
    if (attempt >= 20) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return requestDailyMemoryReview(attempt + 1);
  }
}

async function runEveningPersonalizationTransition(): Promise<boolean> {
  if (systemSuspended || !personalizationScheduler) return false;

  let review = '';
  serviceManager.startService('tutor-server');
  personalizationScheduler.beginInteractiveInference();
  try {
    review = await requestDailyMemoryReview();
  } catch (error) {
    log.warn(
      `[Evening] Could not generate memory review: ${(error as Error).message}`,
    );
  } finally {
    personalizationScheduler.endInteractiveInference();
  }

  const result = await setCocoSleepMode(true, {
    wakeAfterPersonalization: true,
  });
  if (!result.success) return false;

  const message = [
    review ||
      "I don't have enough activity in memory to summarize today, but it's still a good time to pause.",
    '**Take a break when you can.** Coco is now asleep and running today’s personalization update.',
    'Coco will wake automatically when the update finishes. You can still chat while it runs.',
  ].join('\n\n');
  const payload: NotificationPayload = {
    message,
    actionLabel: 'Chat with Coco',
    deferIfBusy: true,
  };
  const shown = showNotification(payload);
  const queued = deferredNotificationPayload === payload;
  log.info('[Evening] Coco entered sleep mode for personalization.');
  return shown || queued;
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

ipcMain.removeHandler('get-wake-word-settings');
ipcMain.handle('get-wake-word-settings', () => ({
  enabled: wakeWordEnabled,
  keywords: [...WAKE_WORDS],
  capturePaused: wakeWordCapturePaused,
  ...wakeWordStatus,
  logPath: path.join(app.getPath('userData'), 'logs', 'wake-word.log'),
}));

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
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (!granted) {
        return {
          success: false,
          error:
            'Microphone access is required. Enable Coco under Privacy & Security → Microphone.',
        };
      }
    }
    wakeWordEnabled = enabled;
    if (!enabled) setWakeWordCapturePaused(false);
    saveWakeWordEnabled(enabled);
    syncWakeWordService();
    const settings = {
      enabled,
      keywords: [...WAKE_WORDS],
      capturePaused: wakeWordCapturePaused,
      ...wakeWordStatus,
    };
    chatWindow?.webContents.send('wake-word-settings-changed', settings);
    wakeWordCaptureWindow?.webContents.send(
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
    setWakeWordCapturePaused(paused);
    return { success: true, paused };
  },
);

ipcMain.removeAllListeners('wake-word-capture-renderer-ready');
ipcMain.on('wake-word-capture-renderer-ready', (event) => {
  if (
    !wakeWordCaptureWindow ||
    event.sender !== wakeWordCaptureWindow.webContents
  ) {
    return;
  }
  // getUserMedia can remain pending forever in a genuinely hidden renderer on
  // macOS. Keep this 1 px, fully transparent window technically visible.
  wakeWordCaptureWindow.showInactive();
  wakeWordCaptureWindow.webContents.send('wake-word-settings-changed', {
    enabled: wakeWordEnabled,
    keywords: [...WAKE_WORDS],
    capturePaused: wakeWordCapturePaused,
    ...wakeWordStatus,
  });
  setImmediate(() => {
    wakeWordCaptureWindow?.webContents.send('wake-word-capture-window-ready');
  });
  log.info('[Wake word] Microphone capture renderer ready');
});

ipcMain.removeAllListeners('wake-word-detection-ack');
ipcMain.on(
  'wake-word-detection-ack',
  (event, value: { id?: unknown } | undefined) => {
    if (!chatWindow || event.sender !== chatWindow.webContents) return;
    const id = typeof value?.id === 'number' ? value.id : null;
    if (!pendingWakeWordDetection || pendingWakeWordDetection.id !== id) return;
    if (pendingWakeWordDetection.retryTimer) {
      clearTimeout(pendingWakeWordDetection.retryTimer);
    }
    log.info(
      `[Wake word] Chat acknowledged detection ${id} after ${pendingWakeWordDetection.attempts} attempt(s)`,
    );
    pendingWakeWordDetection = null;
  },
);

ipcMain.removeAllListeners('wake-word-capture-status');
ipcMain.on('wake-word-capture-status', (event, value: unknown) => {
  if (
    !wakeWordCaptureWindow ||
    event.sender !== wakeWordCaptureWindow.webContents
  ) {
    return;
  }
  const status = value as { state?: unknown; detail?: unknown } | undefined;
  const state = typeof status?.state === 'string' ? status.state : 'unknown';
  if (state === wakeWordCaptureState && !status?.detail) return;
  wakeWordCaptureState = state;
  const detail = typeof status?.detail === 'string' ? `: ${status.detail}` : '';
  log.info(`[Wake word] Microphone capture ${state}${detail}`);
  chatWindow?.webContents.send('wake-word-capture-status', {
    state,
    detail: typeof status?.detail === 'string' ? status.detail : undefined,
  });
});

ipcMain.removeAllListeners('wake-word-audio-frame');
ipcMain.on('wake-word-audio-frame', (event, frame: unknown) => {
  if (
    !wakeWordEnabled ||
    isCocoSleeping() ||
    systemSuspended ||
    wakeWordCapturePaused ||
    !wakeWordCaptureWindow ||
    event.sender !== wakeWordCaptureWindow.webContents
  ) {
    return;
  }
  if (frame instanceof Uint8Array) {
    wakeWordService?.writeAudio(Buffer.from(frame));
  } else if (frame instanceof ArrayBuffer) {
    wakeWordService?.writeAudio(Buffer.from(new Uint8Array(frame)));
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

ipcMain.removeAllListeners('notification-hover-state');
ipcMain.on(
  'notification-hover-state',
  (_event, { hovered }: { hovered?: boolean }) => {
    notificationHovered = hovered === true;
  },
);

ipcMain.removeAllListeners('notification-revealed-state');
ipcMain.on(
  'notification-revealed-state',
  (event, { revealed }: { revealed?: boolean }) => {
    if (
      !notificationWindow ||
      notificationWindow.isDestroyed() ||
      event.sender !== notificationWindow.webContents
    ) {
      return;
    }
    revealedSuggestionOpen = revealed === true;
    log.info(
      `[Notification] Revealed suggestion ${revealedSuggestionOpen ? 'pinned' : 'unpinned'}.`,
    );
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

ipcMain.on('shell-show-item-in-finder', (_event, fullPath) => {
  try {
    if (fs.statSync(fullPath).isDirectory()) {
      void shell.openPath(fullPath);
      return;
    }
  } catch {
    // Fall through so Finder/Explorer can reveal the nearest valid location.
  }
  shell.showItemInFolder(fullPath);
});

ipcMain.removeHandler('get-training-screenshot-retention');
ipcMain.handle('get-training-screenshot-retention', () => {
  const userData = app.getPath('userData');
  const recordsRoot = path.join(userData, 'coco-records');
  return {
    enabled: trainingScreenshotRetentionEnabled(),
    recordsRoot,
    screenshotPattern: path.join(
      recordsRoot,
      'session_*',
      'observer_screenshots',
    ),
    configurationPath: path.join(userData, '.env'),
  };
});

ipcMain.removeHandler('get-personalization-status');
ipcMain.handle('get-personalization-status', () => ({
  ...(personalizationScheduler?.getStatus() ?? {
    available: false,
    sleeping: isCocoSleeping(),
    successfulUpdateCount: 0,
    state: 'idle',
  }),
  dailyRun: eveningPersonalizationScheduler?.getStatus() ?? {
    scheduledHour: 18,
  },
}));

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

const validAvatarDragPoint = (
  value: unknown,
): value is { screenX: number; screenY: number } => {
  const point = value as { screenX?: unknown; screenY?: unknown } | null;
  return Number.isFinite(point?.screenX) && Number.isFinite(point?.screenY);
};

ipcMain.removeAllListeners('avatar-drag-start');
ipcMain.on('avatar-drag-start', (event, value: unknown) => {
  if (
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    event.sender !== avatarWindow.webContents ||
    !validAvatarDragPoint(value)
  ) {
    return;
  }
  const [windowX, windowY] = avatarWindow.getPosition();
  avatarDragOffset = {
    x: value.screenX - windowX,
    y: value.screenY - windowY,
  };
});

ipcMain.removeAllListeners('avatar-drag-move');
ipcMain.on('avatar-drag-move', (event, value: unknown) => {
  if (
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    event.sender !== avatarWindow.webContents ||
    !avatarDragOffset ||
    !validAvatarDragPoint(value)
  ) {
    return;
  }
  avatarWindow.setPosition(
    Math.round(value.screenX - avatarDragOffset.x),
    Math.round(value.screenY - avatarDragOffset.y),
  );
});

ipcMain.removeAllListeners('avatar-drag-end');
ipcMain.on('avatar-drag-end', (event) => {
  if (avatarWindow && event.sender === avatarWindow.webContents) {
    avatarDragOffset = null;
  }
});

ipcMain.removeAllListeners('activity-history-visibility');
ipcMain.on(
  'activity-history-visibility',
  (_event, { visible }: { visible?: boolean }) => {
    hiddenAvatarVisibility.setVisible('history', visible === true);
    syncHiddenAvatarWindowVisibility();
  },
);

ipcMain.removeAllListeners('daily-memory-review-visibility');
ipcMain.on(
  'daily-memory-review-visibility',
  (_event, { visible }: { visible?: boolean }) => {
    hiddenAvatarVisibility.setVisible(
      'daily-memory-review',
      visible === true,
    );
    syncHiddenAvatarWindowVisibility();
  },
);

ipcMain.removeAllListeners('avatar-renderer-ready');
ipcMain.on('avatar-renderer-ready', () => {
  avatarRendererReady = true;
  if (pendingOpenHistory) openHistory();
  if (pendingSocialAvatarNotification && avatarWindow) {
    avatarWindow.webContents.send(
      'social-avatar-notification',
      pendingSocialAvatarNotification,
    );
    pendingSocialAvatarNotification = null;
  }
});

// ── Proactive session IPC handlers ────────────────────────────────────────────

// Webapp signals that a tutor session is now active (or has ended).
// Payload: { active: boolean; sessionId?: string }
ipcMain.removeAllListeners('session-active');
ipcMain.on(
  'session-active',
  (_event, payload: { active: boolean; sessionId?: string }) => {
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
        .catch((e) =>
          log.warn('Could not notify sensing server of session end:', e),
        );
  }
    log.info(
      `[ProactiveSession] isSessionActive=${payload.active}, sessionId=${payload.sessionId}`,
    );
  },
);

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
    if (
      typeof profile.customSystemPrompt === 'string' &&
      profile.customSystemPrompt.trim()
    ) {
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
// For each Tier-2 candidate, ask the tutor server for a ready-to-use suggestion
// and cache the in-flight promise by observation_id. Nothing is presented until
// this second-stage usefulness check succeeds, after which a click can reveal
// the cached result instantly.
const suggestionCache = new Map<
  string,
  {
    ts: number;
    promise: Promise<GeneratedInstantSuggestion | null>;
    available: boolean;
  }
>();
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
    log.warn(
      `[Suggestion] Launching ${tool.label} (${open.via}) is only supported on macOS.`,
    );
  }
}

function pruneSuggestionCache() {
  const now = Date.now();
  for (const [key, entry] of suggestionCache) {
    if (now - entry.ts > SUGGESTION_TTL_MS) suggestionCache.delete(key);
  }
}

// Fire the suggestion request for a Tier-2 candidate and stash the promise.
// Never throws — failures resolve to null and therefore produce no offer.
function precomputeSuggestion(event: {
  observation_id?: string;
  observation?: string;
  status?: string;
  task_label?: string;
  scenario?: string;
  image_paths?: string[];
  retrieved_context?: ObservationEvent['retrieved_context'];
}): Promise<GeneratedInstantSuggestion | null> | undefined {
  const id = event.observation_id;
  if (!id) return undefined;
  const cached = suggestionCache.get(id);
  if (cached) return cached.promise;
  pruneSuggestionCache();

  const { aiTools, scenario } = readProfile();
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const startedAt = Date.now();
  log.info(
    `[InstantSuggestion] precompute start id=${id} status=${event.status}`,
  );
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
      const data = resp.data as GeneratedInstantSuggestion;
      if (data.kind === 'abstain') {
        const entry = suggestionCache.get(id);
        if (entry) entry.available = false;
        log.info(
          `[InstantSuggestion] tutor abstained id=${id} in ${Date.now() - startedAt}ms`,
        );

        // The instant tutor acts as a second-stage check on the observer's
        // need_support=yes decision. Feed an abstention back as a negative
        // label tied to that exact observer call.
        const surface = hideAvatarMode ? 'notification' : 'bubble';
        const sensingPort = process.env.SENSING_PORT || '8080';
        axios
          .post(
            `http://127.0.0.1:${sensingPort}/feedback`,
            {
              kind: 'abstain',
              surface,
              observation_id: id,
              status: event.status ?? null,
              text:
                'Instant suggestion tutor found no useful suggestion to show.',
            },
            { timeout: 3000 },
          )
          .catch((err) => {
            log.warn(
              `[Feedback] failed to post tutor abstention: ${(err as Error).message}`,
            );
          })
          .finally(() => personalizationScheduler?.noteFeedback());

        // The observer bubble may already be visible while generation was in
        // flight. Suppress only the matching, still-unrevealed offer.
        if (avatarWindow && !avatarWindow.isDestroyed()) {
          avatarWindow.webContents.send(
            'suppress-unrevealed-proactive-suggestion',
            { observationId: id },
          );
        }
        return data;
      }
      recordSupportSuggestion(id, data);
      log.info(
        `[InstantSuggestion] precompute ready id=${id} kind=${data?.kind} in ${Date.now() - startedAt}ms`,
      );
      return data;
    })
    .catch((err) => {
      const entry = suggestionCache.get(id);
      if (entry) entry.available = false;
      log.warn(
        `[InstantSuggestion] precompute failed for ${id} after ${Date.now() - startedAt}ms: ${(err as { message?: string })?.message}`,
      );
      return null;
    })
    .finally(() => personalizationScheduler?.endInteractiveInference());
  suggestionCache.set(id, {
    ts: Date.now(),
    promise,
    available: true,
  });
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
    if (value.kind === 'abstain') {
      return { status: 'abstained' };
    }
    // Attach the user's own tools so a delegate bubble can offer one Open button
    // per available chatbot/agent (recommended tool first).
    const suggestion: ReadyInstantSuggestion =
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
  (
    _event,
    {
      toolId,
      copyText,
      observationId,
      status,
      surface = 'bubble',
    }: {
      toolId?: string | null;
      copyText?: string;
      observationId?: string;
      status?: string;
      surface?: 'bubble' | 'notification';
    },
  ) => {
    if (copyText) {
      clipboard.writeText(copyText);
      queueGatewayInteraction({
        kind: 'copy',
        surface,
        observation_id: observationId,
        status,
        stage: 'revealed',
      });
    }
    if (toolId) {
      openAiTool(toolId);
      queueGatewayInteraction({
        kind: 'open_tool',
        surface,
        observation_id: observationId,
        status,
        stage: 'revealed',
        tool_id: toolId,
      });
    }
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
      suggestion?: ReadyInstantSuggestion;
      surface?: 'bubble' | 'notification';
      copyPromptToInput?: boolean;
    },
  ) => {
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
    queueGatewayInteraction({
      kind: 'engage',
      surface: payload.surface ?? 'bubble',
      observation_id: payload.observationId,
      status: payload.status ?? 'observing',
      destination: 'conversation',
    });
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
      await createProactiveTutorSession(
        suggestion.title,
        120,
        seed,
        'proactive_suggestion',
      );
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
  startTrigger: 'proactive_suggestion' | 'user_message' | 'manual' = 'manual',
): Promise<string | null> {
  if (currentSessionId && !endedGatewaySessions.has(currentSessionId)) {
    endCurrentSession('user_ended');
  }
  // Read the user's onboarding profile to get their selected AI tools and mode.
  const { aiTools, scenario, customObserverPrompt, userName } = readProfile();

  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const sensing = `http://127.0.0.1:${sensingPort}`;
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const sessionId = randomUUID();
  const modelConfig = readModelConfiguration();
  const selectedTutor = resolveTutorRuntimeConnection();
  currentTutorModelId = selectedTutor?.id ?? null;

  // Open the chat panel immediately so the user always gets a UI, even if a
  // server is still starting up. Configuration below is best-effort.
  currentSessionId = sessionId;
  isSessionActive = true;
  openChatForSession(sessionId, problemStatement, seed);
  log.info(`[ProactiveSession] Local tutor session started: ${sessionId}`);
  queueGatewayOperation('session_start', {
    _id: sessionId,
    started_at: new Date().toISOString(),
    start_trigger: startTrigger,
    scenario,
    ...(selectedTutor?.model ? { tutor_model: selectedTutor.model } : {}),
    ...(modelConfig?.sensing.model
      ? { observer_model: modelConfig.sensing.model }
      : {}),
    app_run_id: appRunId,
    repository: 'coco',
    ...(process.env.COCO_GIT_COMMIT_SHA
      ? { git_commit_sha: process.env.COCO_GIT_COMMIT_SHA }
      : {}),
    ...(process.env.COCO_GIT_BRANCH
      ? { git_branch: process.env.COCO_GIT_BRANCH }
      : {}),
  });

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
    await axios.post(
      `${tutor}/config/scenario`,
      { scenario },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/problem_statement`,
      { problem_statement: problemStatement },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/ai_tools`,
      { ai_tools: aiTools },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/user_name`,
      { user_name: userName },
      { timeout: 8000 },
    );
    // Re-apply the persisted long-term memory so a freshly (re)started tutor
    // process always has it, independent of its own on-disk load.
    const savedMemory = readLocalMemory();
    if (savedMemory) {
      await axios.post(
        `${tutor}/context/memory`,
        { memory: savedMemory },
        { timeout: 8000 },
      );
    }
  } catch (err) {
    log.warn(
      `[ProactiveSession] Tutor context setup failed: ${(err as Error).message}`,
    );
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
        ...(customObserverPrompt && {
          custom_observer_prompt: customObserverPrompt,
        }),
      },
      { timeout: 15000 },
    );
  } catch (err) {
    log.warn(
      `[ProactiveSession] Sensing session setup failed (proactive disabled): ${(err as Error).message}`,
    );
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
      const sessionId = await createProactiveTutorSession(
        task,
        120,
        undefined,
        'manual',
      );
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
    const { aiTools, scenario, userName } = readProfile();
    try {
      await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
      const selectedTutor = resolveTutorRuntimeConnection(
        conversation.tutorModelId,
      );
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
      await axios.post(
        `${tutor}/context/user_name`,
        { user_name: userName },
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
ipcMain.on(
  'proactive-session-confirmed',
  async (
    _event,
    {
      struggleSeconds,
      taskLabel,
    }: { struggleSeconds: number; taskLabel?: string },
  ) => {
  sessionSetupWindow?.destroy();
  // Prefer the user-edited task label from the setup window; fall back to
  // the auto-detected pendingTaskLabel, then a generic default.
    const problemStatement =
      taskLabel?.trim() || pendingTaskLabel || 'General help session';
  await createProactiveTutorSession(
    problemStatement,
    struggleSeconds,
    undefined,
    'proactive_suggestion',
  );
  },
);

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
function endCurrentSession(
  completionReason: 'user_ended' | 'app_quit' | 'error' = 'user_ended',
) {
  const endingSessionId = currentSessionId;
  if (endingSessionId && !endedGatewaySessions.has(endingSessionId)) {
    endedGatewaySessions.add(endingSessionId);
    queueGatewayOperation('session_end', {
      session_id: endingSessionId,
      ended_at: new Date().toISOString(),
      completion_reason: completionReason,
    });
  }
  isSessionActive = false;
  currentSessionId = null;
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.hide();
    avatarWindow?.show();
  }
  const sensingPort = process.env.SENSING_PORT || '8080';
  axios
    .post(`http://127.0.0.1:${sensingPort}/session/end`)
    .catch((e) =>
      log.warn('Could not notify sensing server of session end:', e),
    );
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
    const requestStartedAt = new Date();
    const assistantMessageId = `assistant-${requestId}`;
    let firstTokenAt: Date | null = null;
    let streamedText = '';
    queueGatewayMessage({
      _id: `user-${requestId}`,
      a: { type: 'user', id: currentUserId || 'participant' },
      content: userText,
      ts: requestStartedAt.toISOString(),
      message_kind: 'user_response',
      request_started_at: requestStartedAt.toISOString(),
    });
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
        log.warn(
          `[Chat] Failed to write pasted image: ${(err as Error).message}`,
        );
      }
    }

    const contextualizedUserText =
      hotkeyImageCount > 0
      ? [
          '<hotkey_screenshot_context>',
          `${hotkeyImageCount} attached image${hotkeyImageCount === 1 ? ' was' : 's were'} deliberately captured by the user with Coco's screenshot hotkey.`,
          'Treat the attached hotkey capture as the primary visual state the user chose for this request. Do not call observe_screen merely to capture or inspect the same screen again. Only request a new live-screen observation if the user explicitly asks for an updated view after this capture.',
          '</hotkey_screenshot_context>',
          userText,
          ]
            .filter(Boolean)
            .join('\n')
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
          if (streamEvent.type === 'text_delta') {
            if (!firstTokenAt) firstTokenAt = new Date();
            if (typeof streamEvent.text === 'string') {
              streamedText += streamEvent.text;
            }
          }
          if (streamEvent.type === 'done') {
            const completedAt = new Date();
            const content =
              typeof streamEvent.guidance === 'string'
                ? streamEvent.guidance
                : streamedText;
            const metrics =
              streamEvent.llm_metrics &&
              typeof streamEvent.llm_metrics === 'object'
                ? (streamEvent.llm_metrics as Record<string, unknown>)
                : {};
            queueGatewayMessage({
              _id: assistantMessageId,
              a: { type: 'AITutor', id: 'coco' },
              content,
              ts: completedAt.toISOString(),
              request_started_at: requestStartedAt.toISOString(),
              first_token_at: (firstTokenAt ?? completedAt).toISOString(),
              response_completed_at: completedAt.toISOString(),
              ...(typeof metrics.model === 'string'
                ? { model: metrics.model }
                : {}),
              message_kind: 'user_response',
            });
          }
          ipcEvent.sender.send('chat-stream-event', {
            requestId,
            ...streamEvent,
            ...(streamEvent.type === 'done'
              ? {
                  messageId: assistantMessageId,
                  observerMetrics: streamEvent.observer_metrics ?? null,
                }
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
      log.error(
        '[Chat] streaming user prompt failed:',
        JSON.stringify(ax?.response?.data ?? ax?.message),
      );
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
  const preview = (payload ?? {}) as {
    imageDataUrl?: unknown;
    editable?: unknown;
  };
  const { imageDataUrl } = preview;
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
    preview.editable === true,
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
    editable: imagePreviewEditable,
    fullScreenOverlay: imagePreviewFullScreenOverlay,
  });
  if (
    process.platform === 'darwin' &&
    !imagePreviewWindow.isSimpleFullScreen()
  ) {
    imagePreviewWindow.setSimpleFullScreen(true);
  }
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
    dismissImagePreviewWindow(imagePreviewWindow);
  }
});

ipcMain.removeAllListeners('save-image-annotation');
ipcMain.on('save-image-annotation', (event, payload: unknown) => {
  const annotatedImageDataUrl = (
    payload as { imageDataUrl?: unknown } | null
  )?.imageDataUrl;
  if (
    !imagePreviewEditable ||
    !imagePreviewDataUrl ||
    !imagePreviewWindow ||
    imagePreviewWindow.isDestroyed() ||
    imagePreviewWindow.webContents.id !== event.sender.id ||
    typeof annotatedImageDataUrl !== 'string' ||
    !annotatedImageDataUrl.startsWith('data:image/png;base64,') ||
    annotatedImageDataUrl.length > 50_000_000
  ) {
    log.warn('[ImagePreview] Ignored an invalid annotation result.');
    return;
  }

  if (imagePreviewAnnotationResult === 'attach') {
    pendingHotkeyCaptures.push(annotatedImageDataUrl);
    showChatPanel();
    flushHotkeyCaptures();
  } else if (
    imagePreviewSourceWindow &&
    !imagePreviewSourceWindow.isDestroyed()
  ) {
    imagePreviewSourceWindow.webContents.send('image-annotation-saved', {
      originalImageDataUrl: imagePreviewDataUrl,
      imageDataUrl: annotatedImageDataUrl,
    });
  }
  dismissImagePreviewWindow(imagePreviewWindow);
});

ipcMain.removeHandler('send-audio-message');
ipcMain.handle(
  'send-audio-message',
  async (
    ipcEvent,
    {
      requestId,
      audioData,
    }: {
      requestId: string;
      audioData: string;
    },
  ) => {
    if (!audioData || audioData.length > 16_000_000) {
      return { error: 'The voice recording is empty or too large.' };
    }
    const modelConfig = readModelConfiguration();
    const selectedTutor =
      modelConfig?.tutors.find((item) => item.id === currentTutorModelId) ??
      (modelConfig ? defaultTutor(modelConfig) : null);
    if (!selectedTutor?.supportsAudio) {
      return {
        error:
          'The selected tutor model does not support audio input. Choose an audio-capable tutor or type your message.',
      };
    }
    const tutorPort = process.env.TUTOR_PORT || '8081';
    const requestStartedAt = new Date();
    const assistantMessageId = `assistant-${requestId}`;
    let firstTokenAt: Date | null = null;
    let streamedText = '';
    queueGatewayMessage({
      _id: `user-${requestId}`,
      a: { type: 'user', id: currentUserId || 'participant' },
      content: '[Voice message]',
      ts: requestStartedAt.toISOString(),
      message_kind: 'voice_response',
      request_started_at: requestStartedAt.toISOString(),
    });
    personalizationScheduler?.beginInteractiveInference();
    try {
      await consumeTutorStream(
        `http://127.0.0.1:${tutorPort}/events/audio_prompt/stream`,
        {
          audio_data: audioData,
          audio_format: 'wav',
          session_id: currentSessionId,
        },
        (streamEvent: TutorStreamEvent) => {
          if (streamEvent.type === 'text_delta') {
            if (!firstTokenAt) firstTokenAt = new Date();
            if (typeof streamEvent.text === 'string') {
              streamedText += streamEvent.text;
            }
          }
          if (streamEvent.type === 'done') {
            const completedAt = new Date();
            const content =
              typeof streamEvent.guidance === 'string'
                ? streamEvent.guidance
                : streamedText;
            const metrics =
              streamEvent.llm_metrics &&
              typeof streamEvent.llm_metrics === 'object'
                ? (streamEvent.llm_metrics as Record<string, unknown>)
                : {};
            queueGatewayMessage({
              _id: assistantMessageId,
              a: { type: 'AITutor', id: 'coco' },
              content,
              ts: completedAt.toISOString(),
              request_started_at: requestStartedAt.toISOString(),
              first_token_at: (firstTokenAt ?? completedAt).toISOString(),
              response_completed_at: completedAt.toISOString(),
              ...(typeof metrics.model === 'string'
                ? { model: metrics.model }
                : {}),
              message_kind: 'voice_response',
            });
          }
          ipcEvent.sender.send('chat-stream-event', {
            requestId,
            ...streamEvent,
            ...(streamEvent.type === 'done'
              ? { messageId: assistantMessageId }
              : {}),
          });
        },
        undefined,
        {
          idleMs: 60_000,
          hardMs: 5 * 60_000,
        },
      );
      return { streamed: true };
    } catch (err) {
      log.error(
        '[Chat] streaming audio prompt failed:',
        err instanceof Error ? err.message : String(err),
      );
      const error =
        err instanceof TutorStreamTimeoutError
          ? 'The tutor took too long to respond to the voice message. Please retry.'
          : 'The tutor could not process the voice message. Please try again.';
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
      if (
        !cached ||
        !cached.available ||
        Date.now() - cached.ts > SUGGESTION_TTL_MS
      ) {
        return record;
      }
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
      fs.writeFileSync(
        profilePath(),
        JSON.stringify(profile, null, 2),
        'utf-8',
      );
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
      fs.writeFileSync(
        profilePath(),
        JSON.stringify(profile, null, 2),
        'utf-8',
      );
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
      await axios.post(
        `${tutor}/config/scenario`,
        { scenario },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/ai_tools`,
        { ai_tools: aiTools },
        { timeout: 8000 },
      );
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
            ...(customObserverPrompt && {
              custom_observer_prompt: customObserverPrompt,
            }),
          },
          { timeout: 15000 },
        );
      } catch (err) {
        log.warn(
          `[Settings] Sensing scenario update failed: ${(err as Error).message}`,
        );
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
    const resp = await axios.get(
      `http://127.0.0.1:${tutorPort}/context/memory`,
      { timeout: 8000 },
    );
    return {
      memory: String((resp.data as { memory?: unknown })?.memory ?? ''),
    };
  } catch {
    return { memory: '' };
  }
});

ipcMain.removeHandler('save-memory');
ipcMain.handle(
  'save-memory',
  async (_event, { memory }: { memory: string }) => {
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
      await axios.post(
        `http://127.0.0.1:${tutorPort}/context/memory`,
        { memory },
        { timeout: 8000 },
      );
  } catch (err) {
    log.warn(`[Memory] live apply failed: ${(err as Error).message}`);
  }
  return { success: true };
  },
);

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
        log.warn(
          `[Memory] daily update live apply failed: ${(err as Error).message}`,
        );
      }
      log.info(
        `[Memory] approved daily personalization draft ${draft.draftId}`,
      );
      return { success: true, draftId: draft.draftId };
    } catch (err) {
      log.warn(
        `[Memory] failed to approve daily update: ${(err as Error).message}`,
      );
      return { success: false, error: (err as Error).message };
    }
  },
);

// Legacy renderer hook. A verified participant identity cannot be replaced by
// a renderer-provided local UUID after authentication.
ipcMain.handle('set-user-id', async (event, userId) => {
  if (!userId || typeof userId !== 'string') {
    log.error('Invalid userId provided to set-user-id');
    return { success: false, error: 'Invalid userId' };
  }
  if (isAuthenticated && userId !== currentUserId) {
    log.warn('[User] rejected an attempt to replace authenticated identity');
    return {
      success: false,
      error: 'Authenticated participant ID cannot change.',
    };
  }
  currentUserId = userId;
  log.info(`[User] local userId set to ${userId}`);
  return { success: true };
});

interface DesktopAuthCredentials {
  participantId?: string;
  password?: string;
  keepSignedIn?: boolean;
}

const initializeGatewayParticipant = (participantId: string): void => {
  currentUserId = participantId;
  isAuthenticated = true;
  if (!gatewayClient) return;
  socialBackgroundPoller.start();
  gatewayOutbox = new GatewayOutbox(
    app.getPath('userData'),
    participantId,
    gatewayClient,
    log,
  );
  void gatewayOutbox.flush();
  if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
  telemetryFlushTimer = setInterval(() => {
    void gatewayOutbox?.flush();
  }, 30_000);
};

const configureParticipantRouterCredential = async (): Promise<void> => {
  if (!gatewayClient || !process.env.LLM_ROUTER_URL?.trim()) return;
  const credential = await gatewayClient.issueRouterCredential();
  process.env.LLM_ROUTER_API_KEY = credential.token;
  ensureManagedDefaultModelConfiguration();
  log.info('[Auth] participant-scoped LLM Router credential configured');
};

const authenticate = async (
  mode: 'signin' | 'signup',
  credentials: DesktopAuthCredentials,
) => {
  if (!gatewayClient) {
    return { success: false, error: 'The Coco study server is not configured.' };
  }
  if (
    typeof credentials?.participantId !== 'string' ||
    typeof credentials?.password !== 'string'
  ) {
    return { success: false, error: 'Participant ID and password are required.' };
  }
  try {
    const request = {
      participantId: credentials.participantId.trim(),
      password: credentials.password,
      keepSignedIn: credentials.keepSignedIn !== false,
    };
    const session =
      mode === 'signup'
        ? await gatewayClient.signUp(request)
        : await gatewayClient.signIn(request);
    await configureParticipantRouterCredential();
    initializeGatewayParticipant(session.participantId);
    pendingAuthLaunch = mode;
    if (request.keepSignedIn) {
      saveAuthSession(app.getPath('userData'), {
        token: session.token,
        participantId: session.participantId,
        expiresAt: session.expiresAt,
      });
    } else {
      clearAuthSession(app.getPath('userData'));
    }
    log.info(`[Auth] ${mode} succeeded for ${session.participantId}`);
    return { success: true, participantId: session.participantId };
  } catch (error) {
    log.warn(`[Auth] ${mode} failed: ${String(error)}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

ipcMain.handle('auth-signup', (_event, credentials: DesktopAuthCredentials) =>
  authenticate('signup', credentials),
);
ipcMain.handle('auth-signin', (_event, credentials: DesktopAuthCredentials) =>
  authenticate('signin', credentials),
);
ipcMain.removeAllListeners('auth-logout');
ipcMain.on('auth-logout', () => {
  try {
    clearAuthSession(app.getPath('userData'));
    log.info('[Auth] signed out; restarting at the authentication screen');
    app.relaunch();
    app.quit();
  } catch (error) {
    log.error(`[Auth] could not clear the saved session: ${String(error)}`);
  }
});
registerSocialIpcHandlers(ipcMain, socialService);
registerKnowledgeAnswerIpcHandler(ipcMain, knowledgeAnswerService);

ipcMain.removeAllListeners('authentication-ui-complete');
ipcMain.on('authentication-ui-complete', () => {
  if (!isAuthenticated || !pendingAuthLaunch) return;
  pendingAuthLaunch = null;
  authWindow?.destroy();
  void launchDesktopSurfaces();
});

const createWindow = async () => {
  if (gatewayClient && !isAuthenticated) {
    createAuthWindow();
    createTray();
    return;
  }
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

};

let desktopSurfacesLaunched = false;
async function launchDesktopSurfaces(): Promise<void> {
  if (gatewayClient && !isAuthenticated) {
    createAuthWindow();
    createTray();
    return;
  }
  if (desktopSurfacesLaunched) {
    await createWindow();
    return;
  }
  desktopSurfacesLaunched = true;
  await requestRequiredMacPermissions();
  initializeWakeWordService();
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
  await createWindow();
  createWakeWordCaptureWindow();
  // Keep chat state alive while its panel is closed.
  createChatWindow();
}

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
  if (gatewayClient && !isAuthenticated) {
    createAuthWindow();
  } else if (onboardingWindow && !onboardingWindow.isDestroyed()) {
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
  eveningPersonalizationScheduler?.stop();
  socialBackgroundPoller.stop();
  if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
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
    tutor: (runtime
      ? defaultTutor(runtime.config).model
      : process.env.TUTOR_MODEL || ''
    ).trim(),
    observer: (
      runtime?.config.sensing.model ||
      process.env.OBSERVER_MODEL ||
      ''
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
    configureServiceModelArguments(serviceManager, tutorModel, observerModel);
    const runtime = resolveModelRuntime();
    if (runtime) {
      const { userName } = readProfile();
      serviceManager.configureServiceEnv(
        'tutor-server',
        {
          ...runtime.tutorEnv,
          ...(userName && { COCO_USER_NAME: userName }),
        },
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
      collectTrainingScreenshots: trainingScreenshotRetentionEnabled(),
      evolveConcurrency: requestedPersonalizationConcurrency(
        process.env.COCO_PERSONALIZATION_LLM_CONCURRENCY,
      ),
      logPath: path.join(
        app.getPath('userData'),
        'logs',
        'personalization.log',
      ),
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      onFatalError: (error: PersonalizationFatalError) => {
        queueFatalError('personalization', error);
      },
      onRunEvent: queuePersonalizationRunEvent,
      onJobFinished: (job, outcome) => {
        if (job !== 'evolve') return;
        if (outcome === 'completed') {
          avatarWindow?.webContents.send('daily-memory-draft-refresh');
        }
        if (
          wakeAfterEveningPersonalization &&
          (outcome === 'completed' || outcome === 'no_work')
        ) {
          eveningPersonalizationScheduler?.markCompleted(outcome);
          wakeAfterEveningPersonalization = false;
          void setCocoSleepMode(false).then((result) => {
            if (result.success) {
              log.info(
                '[Evening] Coco woke after the personalization update finished.',
              );
            } else {
              log.warn(
                `[Evening] Could not wake Coco after personalization: ${result.error}`,
              );
            }
          }).catch((error) => {
            log.warn(
              `[Evening] Could not wake Coco after personalization: ${error}`,
            );
          });
        }
      },
    });
    personalizationScheduler.start();
    eveningPersonalizationScheduler?.stop();
    eveningPersonalizationScheduler = new EveningPersonalizationScheduler({
      statePath: path.join(stateRoot, 'evening-review.json'),
      onEvening: runEveningPersonalizationTransition,
    });
    eveningPersonalizationScheduler.start();
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
      const isProactiveSuggestionEvent =
        typeof status === 'string' && PRECOMPUTE_STATUSES.has(status);
      const suppressProactiveSuggestionForChat =
        isProactiveSuggestionEvent && isChatPanelOpen();
      const suppressProactiveSuggestionForCooldown =
        isProactiveSuggestionEvent && event.proactive_allowed === false;

      if (suppressProactiveSuggestionForChat) {
        log.info(
          '[Notification] Suppressed proactive suggestion while Coco chat is open.',
        );
      }
      if (suppressProactiveSuggestionForCooldown) {
        log.info(
          `[Notification] Sensing suppressed proactive suggestion during 60s cooldown ` +
            `(${Math.ceil(event.proactive_cooldown_remaining_s ?? 0)}s remaining).`,
        );
      }

      // Tier-2 friction events from the struggle/pause path arrive without an
      // observation_id, but the precompute cache and the renderer bubble must
      // agree on a key. Since the SAME event object is forwarded to the
      // renderer below, stamp a synthetic id here so both sides line up.
      if (status && PRECOMPUTE_STATUSES.has(status) && !event.observation_id) {
        syntheticObsSeq += 1;
        event.observation_id = `synthetic-${Date.now()}-${syntheticObsSeq}`;
      }

      // Forward observations for avatar mood and Activity history. Proactive
      // events are deliberately not presented by this channel; the renderer
      // waits for `proactive-suggestion-ready` after the tutor's second-stage
      // usefulness check completes.
      if (
        !suppressProactiveSuggestionForChat &&
        !suppressProactiveSuggestionForCooldown &&
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
          proactive_allowed: event.proactive_allowed,
          proactive_support: PRECOMPUTE_STATUSES.has(status)
            ? { engaged: false }
            : undefined,
          llm_metrics: event.llm_metrics,
        });
      }

      const taskLabel = event.task_label;

      // ── Generate and validate proactive support before presenting it ─────
      // Both avatar modes use this same readiness, staleness, and suppression
      // gate. Only the final presentation surface differs.
      if (status && PRECOMPUTE_STATUSES.has(status)) {
        const suggestionIsAlreadyRevealed = hasOpenRevealedSuggestion();
        if (suppressProactiveSuggestionForChat) {
          // The observation is still persisted above for history and training;
          // only proactive generation and presentation are suppressed.
        } else if (suppressProactiveSuggestionForCooldown) {
          // Sensing owns the global policy. The observation is still persisted
          // above, but no tutor request or presentation is started for it.
        } else if (suggestionIsAlreadyRevealed) {
          log.info(
            '[Notification] Suspended proactive suggestions while a revealed suggestion is open.',
          );
        } else {
          latestProactiveSuggestionObservationId = event.observation_id;
          const suggestionPromise = precomputeSuggestion(event);
          if (event.observation) {
            const rawObservation = cleanObservation(event.observation);
            void suggestionPromise?.then((value) => {
              if (
                !value ||
                value.kind === 'abstain' ||
                isChatPanelOpen() ||
                hasOpenRevealedSuggestion() ||
                latestProactiveSuggestionObservationId !== event.observation_id
              ) {
                return;
              }
              const suggestion: ReadyInstantSuggestion =
                value.kind === 'delegate'
                  ? {
                      ...value,
                      availableTools: buildAvailableTools(value.targetTool),
                    }
                  : value;
              if (!hideAvatarMode) {
                if (
                  avatarWindow &&
                  !avatarWindow.isDestroyed() &&
                  avatarRendererReady
                ) {
                  avatarWindow.webContents.send(
                    'proactive-suggestion-ready',
                    {
                      title: suggestion.title,
                      observationId: event.observation_id,
                      status,
                      rawObservation,
                    },
                  );
                }
                return;
              }

              // Hidden-avatar notifications and visible-avatar bubbles both
              // preview this same generated title. The notification owns its
              // shown feedback here; the avatar renderer reports shown only if
              // it actually accepts the offer (for example, it may be hovered).
              const shown = showNotification({
                message: suggestion.title,
                actionLabel: 'Reveal full suggestion',
                notifType: 'proactive-suggestion',
                observationId: event.observation_id,
                status,
                rawObservation,
                suggestion,
              });
              if (!shown) return;
              queueGatewayInteraction({
                kind: 'shown',
                surface: 'notification',
                observation_id: event.observation_id,
                status,
                stage: 'offer',
              });
              const sensingPort = process.env.SENSING_PORT || '8080';
              axios
                .post(
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
                  log.warn(
                    `[Feedback] failed to post: ${(err as Error).message}`,
                  );
                })
                .finally(() => personalizationScheduler?.noteFeedback());
            });
          }
        }
      }

      // ── Pre-session: suggest starting a tutor session ─────────────────
      // The sensing-side judge now owns the invite decision AND its timing
      // (it only emits a task_suggested event when it decides to invite, at
      // most once per its cooldown), so we no longer rate-limit here.
      if (!isSessionActive && status === 'task_suggested' && taskLabel) {
        pendingTaskLabel = taskLabel;
        const message = `I see you're ${taskLabel}. Want me to guide you with AI tools?`;
        const shown = showNotification({
          message,
          actionLabel: 'Yes, start session',
          cancelLabel: 'Not now',
          notifType: 'session-start-prompt',
        });
        if (shown) {
          queueGatewayInteraction({
            kind: 'shown',
            surface: 'session_prompt',
            status: 'session_start',
            stage: 'offer',
          });
        }
      }

      // ── In-session: detect task completion ───────────────────────────
      if (isSessionActive && status === 'task_complete') {
        const shown = showNotification({
          message:
            'Looks like your task is done. Want to wrap up this session?',
          actionLabel: 'Yes, end session',
          cancelLabel: 'Keep going',
          notifType: 'session-end-prompt',
        });
        if (shown) {
          queueGatewayInteraction({
            kind: 'shown',
            surface: 'session_prompt',
            status: 'session_end',
            stage: 'offer',
          });
        }
      }
    },
  });
};

app
  .whenReady()
  .then(async () => {
    // Update checks are independent of authentication, onboarding, and local
    // service startup. The manager delays its first network request briefly.
    desktopAppUpdater.start();
    await configureLocalServicePorts();
    initializeDailyMemoryDraftService();
    powerMonitor.on('suspend', () => {
      log.info('[Power] System suspended; clearing proactive UI and cache.');
      systemSuspended = true;
      syncWakeWordService();
      observationSleepGuard.suspend();
      latestProactiveSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      revealedSuggestionOpen = false;
      deferredNotificationPayload = null;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('system-suspend');
      }
      chatWindow?.webContents.send('system-suspend');
    });

    powerMonitor.on('resume', () => {
      log.info('[Power] System resumed; suppressing observations briefly.');
      systemSuspended = false;
      syncWakeWordService();
      observationSleepGuard.resume();
      latestProactiveSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      revealedSuggestionOpen = false;
      deferredNotificationPayload = null;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        // Send this again in case the renderer was frozen before handling the
        // suspend event.
        avatarWindow.webContents.send('system-suspend');
        avatarWindow.webContents.send('daily-memory-draft-refresh');
      }
      eveningPersonalizationScheduler?.checkNow().catch(() => undefined);
    });

    // Ensure default workspace directory exists
    ensureDefaultWorkspaceExists();

    // Gateway delivery remains opt-in for local development. Study packages
    // embed only service URLs; authentication and model credentials are always
    // obtained at runtime for the active participant.
    gatewayClient = CocoGatewayClient.fromEnvironment(log);
    const storedAuth = readAuthSession(app.getPath('userData'));
    if (gatewayClient && storedAuth) {
      try {
        const restored = await gatewayClient.restoreAuthSession(
          storedAuth.token,
        );
        await configureParticipantRouterCredential();
        initializeGatewayParticipant(restored.participantId);
        log.info(`[Auth] restored session for ${restored.participantId}`);
      } catch (error) {
        clearAuthSession(app.getPath('userData'));
        log.warn(`[Auth] saved session could not be restored: ${String(error)}`);
      }
    }

    await launchDesktopSurfaces();

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
      if (gatewayClient && !isAuthenticated) {
        createAuthWindow();
        return;
      }
      log.info('[ImagePreview] Screenshot hotkey triggered.');
      void beginHotkeyCapture();
    });

    // Cmd/Ctrl+Shift+H — toggle the observation history panel on the avatar.
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (gatewayClient && !isAuthenticated) {
        createAuthWindow();
        return;
      }
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('toggle-observation-history');
      }
    });

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (gatewayClient && !isAuthenticated) createAuthWindow();
      else if (avatarWindow === null && chatWindow === null) {
        void launchDesktopSurfaces();
      }
    });
  })
  .catch(console.log);

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  if (currentSessionId && !endedGatewaySessions.has(currentSessionId)) {
    endedGatewaySessions.add(currentSessionId);
    queueGatewayOperation('session_end', {
      session_id: currentSessionId,
      ended_at: new Date().toISOString(),
      completion_reason: 'app_quit',
    });
  }
  log.info('App quitting: waiting up to 10s for services to stop...');
  desktopAppUpdater.stop();
  stopObservationStream();
  personalizationScheduler?.stop();
  wakeWordService?.stop('disabled');
  const shutdownTimeoutMs = 10_000;
  const finishQuit = () => {
    if (installUpdateAfterShutdown) {
      log.info('Services stopped, restarting to install the downloaded update.');
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    app.quit();
  };
  Promise.allSettled([
    serviceManager.shutdown(shutdownTimeoutMs),
    gatewayOutbox?.flush() ?? Promise.resolve(),
  ])
    .then(() => {
      log.info('Services stopped, quitting app.');
      finishQuit();
    })
    .catch(finishQuit);
});
