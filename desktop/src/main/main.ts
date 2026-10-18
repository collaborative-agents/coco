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
import { exec, execFile, spawn } from 'child_process';
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
  systemPreferences,
  desktopCapturer,
} from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import { DesktopAppUpdater } from './app-updater';
import { installDockUpdateMenu } from './dock-menu';
import { avatarRecoveryItems, cocoNavigationItems } from './avatar-menu';
import setupWindowOptions from './setup-window-options';
import { InteractionTracker } from './interaction-tracker';
import { chatSuggestionText } from '../shared/chat-suggestion';
import type { ChatSuggestion } from '../shared/chat-suggestion';
import {
  SocialService,
  registerSocialIpcHandlers,
} from './services/social-service';
import { registerStudyIpc } from './services/study-service';
import type { StudyState } from '../shared/study';
import {
  registerPreAssessmentIpc,
  syncPreAssessmentState,
} from './pre-assessment-store';
import configureFullscreenCompanionWindow from './services/fullscreen-companion-window';
import configureMainWindow, { resizeMainWindow } from './main-window-behavior';
import log from 'electron-log';
import axios from 'axios';
import { resolveHtmlPath } from './util';
import { serviceManager } from './services/manager';
import { configureServiceModelArguments } from './services/model-arguments';
import {
  retryOperation,
  RetryCancelledError,
} from './services/retry-operation';
import { shouldStartSessionFromUserMessage } from './services/session-start-policy';
import {
  shouldOfferInstantSuggestion,
  shouldSurfaceObservation,
} from './services/intervention-policy';
import {
  startObservationStream,
  stopObservationStream,
} from './services/observation-stream';
import {
  PersonalizationScheduler,
  type PersonalizationFatalError,
} from './services/personalization-scheduler';
import { EveningPersonalizationScheduler } from './services/evening-personalization-scheduler';
import { DailyMemoryDraftService } from './services/daily-memory-drafts';
import { PersonalizationCenterService } from './services/personalization-center';
import { requestedPersonalizationConcurrency } from './runtime-config';
import { NextDaySummaryScheduler } from './services/next-day-summary-scheduler';
import {
  consumeTutorStream,
  TutorTurnTiming,
  TutorStreamTimeoutError,
} from './services/tutor-stream';
import type { TutorStreamEvent } from './services/tutor-stream';
import PiHarness from './services/pi-harness';
import { CocoGatewayClient } from './services/gateway-client';
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
import {
  markLearningRecapsReviewedThrough,
  readLatestUnreviewedLearningDay,
  saveLearningRecap,
} from './learning-recap-store';
import {
  interruptStaleReplies,
  latestConversation,
  readConversations,
  restorableMessages,
  saveConversation,
  saveConversationDirectory,
  setConversationEnded,
  settleStoredReply,
} from './conversation-store';
import type { StoredConversation, StoredReply } from './conversation-store';
import {
  recordSessionEnded,
  recordSessionStarted,
  recordUnderstandingChecked,
} from './session-event-store';
import {
  getSystemPermissionWarning,
  needsWindowsMicrophoneSettings,
  systemPermissionButtonLabel,
  systemPermissionExplanation,
  type SystemPermissionSettingsTarget,
} from './system-permission-warning';
import { openSystemPermissionSettings } from './open-system-permission-settings';
import {
  defaultTutor,
  isLlmRouterConfigured,
  normalizeRouterManagedModelConfiguration,
  ROUTER_MANAGED_MODEL_CONFIGURATION,
  getModelConfigurationView,
  prepareModelConnectionTest,
  readModelConfiguration,
  resolveModelRuntime,
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
} from '../renderer/components/observation-types';
import type {
  ObservationStatus,
  AiToolButton,
  LLMCallMetrics,
} from '../renderer/components/observation-types';
import type { AgentModeId } from '../shared/agent-modes';
import type { SessionStartTrigger } from '../shared/session-start';

const dotenv = require('dotenv');

type EmbeddedRouterConfig = { url?: string; gatewayUrl?: string };
declare const __COCO_BUILD_ROUTER_CONFIG__: EmbeddedRouterConfig | undefined;

const embeddedRouterConfig: EmbeddedRouterConfig =
  typeof __COCO_BUILD_ROUTER_CONFIG__ === 'undefined'
    ? {}
    : __COCO_BUILD_ROUTER_CONFIG__;

const PACKAGED_GATEWAY_URL =
  embeddedRouterConfig.gatewayUrl ||
  'https://coco.upskilling.saltlab.stanford.edu';
// Bump this whenever a packaged release must make every participant complete
// onboarding once again. Development builds do not use this release gate.
const PACKAGED_ONBOARDING_VERSION = 'auth-onboarding-v1';

const isNightlyBuild =
  app.isPackaged && /-nightly\.\d{14}$/.test(app.getVersion());
app.setName(isNightlyBuild ? 'Coco Nightly' : 'Coco');

// Preserve Coco's existing data directory across releases. Nightly builds
// use their own directory so they can coexist with the stable app.
if (app.isPackaged) {
  const packagedUserDataDir = path.join(
    app.getPath('appData'),
    isNightlyBuild ? 'coco-nightly' : 'coco',
  );
  fs.mkdirSync(packagedUserDataDir, { recursive: true });
  app.setPath('userData', packagedUserDataDir);
}

// Coco historically uses the same profile when run from source or installed.
// Keep that default so upgrades retain conversations and personalization.
// First-launch testing can still opt into a separate directory explicitly.
if (!app.isPackaged) {
  const developmentUserDataOverride =
    process.env.COCO_DESKTOP_USER_DATA_DIR?.trim();
  const resolvedUserDataDir = developmentUserDataOverride
    ? path.resolve(developmentUserDataOverride)
    : path.join(app.getPath('appData'), 'coco');
  fs.mkdirSync(resolvedUserDataDir, { recursive: true });
  app.setPath('userData', resolvedUserDataDir);
  log.info(`[Development] userData directory: ${resolvedUserDataDir}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

if (app.isPackaged) {
  // Packaged: read .env from the user-data folder (e.g. ~/Library/Application
  // Support/coco/.env). Only the Router URL is embedded at build time; a
  // participant-scoped credential is fetched after authentication.
  dotenv.config({ path: path.join(app.getPath('userData'), '.env') });
  if (!process.env.LLM_ROUTER_URL && embeddedRouterConfig.url) {
    process.env.LLM_ROUTER_URL = embeddedRouterConfig.url;
  }
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
let wakeWordCaptureWindow: BrowserWindow | null = null;
let notificationWindow: BrowserWindow | null = null;
let nextDaySummaryScheduler: NextDaySummaryScheduler | null = null;
let notificationHovered = false;
let proactiveSuggestionOpen = false;
let latestHiddenSuggestionObservationId: string | undefined;
let authWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let sessionSetupWindow: BrowserWindow | null = null;
let sessionRecapWindow: BrowserWindow | null = null;
let sessionRecapContext: {
  sessionId: string | null;
  userId: string | null;
} | null = null;
let tray: Tray | null = null;
let hideAvatarMode = false;
let avatarRendererReady = false;
let pendingOpenHistory = false;
let personalizationScheduler: PersonalizationScheduler | null = null;
let eveningPersonalizationScheduler: EveningPersonalizationScheduler | null =
  null;
let wakeAfterEveningPersonalization = false;
let dailyMemoryDraftService: DailyMemoryDraftService | null = null;
let personalizationCenterService: PersonalizationCenterService | null = null;
let previewCocoSleepMode = false;

const isDailyMemoryPreviewOnly = () =>
  !app.isPackaged && process.env.COCO_DAILY_MEMORY_PREVIEW_ONLY === '1';


const initializeDailyMemoryDraftService = () => {
  if (dailyMemoryDraftService) return;
  const personalizationStateRoot = path.join(
    app.getPath('userData'),
    'personalization',
  );
  dailyMemoryDraftService = new DailyMemoryDraftService(
    app.getPath('userData'),
    personalizationStateRoot,
    {
      fixtureStatePath: app.isPackaged
        ? undefined
        : process.env.COCO_DAILY_MEMORY_DRAFT_FIXTURE,
    },
  );
  personalizationCenterService = new PersonalizationCenterService(
    personalizationStateRoot,
    dailyMemoryDraftService,
  );
};


let cocoSleeping = false;
let postAssessmentActive = false;
const observationSleepGuard = new ObservationSleepGuard();
let wakeWordService: WakeWordService | null = null;
let wakeWordEnabled = false;
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
const WAKE_WORD_MODEL = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

const isCocoSleeping = () => cocoSleeping || !tutoringAllowed;
const setPostAssessmentActive = (active: boolean) => {
  if (postAssessmentActive === active) return;
  postAssessmentActive = active;
  log.info(
    `[Post-assessment] Proactive suggestions ${active ? 'disabled' : 'enabled'}`,
  );
  if (active) {
    latestHiddenSuggestionObservationId = undefined;
    proactiveSuggestionOpen = false;
    notificationWindow?.destroy();
    sessionSetupWindow?.destroy();
  }
  avatarWindow?.webContents.send('post-assessment-proactive-suppression', {
    active,
  });
};
let tutoringAllowed = true;
let studyPolicyAllowsTutoring = false;
let serverPreAssessmentsComplete = false;
let currentStudyRole: StudyState['role'] | null = null;
let adminStudentMode = false;
let studyAccessStatus:
  | 'checking'
  | 'allowed'
  | 'preassessment'
  | 'disabled'
  | 'unavailable' = 'checking';
process.env.COCO_TUTORING_ALLOWED = '1';

const isStudentExperienceActive = () =>
  currentStudyRole === 'participant' || adminStudentMode;

const areRequiredPreAssessmentsComplete = () => true;

const wakeWordSettingsPath = () =>
  path.join(app.getPath('userData'), 'wake-word.json');

const readWakeWordEnabled = (): boolean => {
  const settingsPath = wakeWordSettingsPath();
  try {
    const enabled =
      JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.enabled === true;
    log.info(`[Wake word] Loaded enabled=${enabled} from ${settingsPath}`);
    return enabled;
  } catch (error) {
    log.info(
      `[Wake word] No saved setting at ${settingsPath}; defaulting disabled (${(error as Error).message})`,
    );
    return false;
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
let isFloatMode = false;
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
      Boolean(currentUserId) &&
      profile?.participantId === currentUserId &&
      (!app.isPackaged ||
        profile?.onboardingVersion === PACKAGED_ONBOARDING_VERSION)
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
// Seed local event records from legacy environment configuration until a
// verified Gateway account establishes the authenticated Participant ID.
let currentUserId = process.env.COCO_GATEWAY_USER_ID?.trim() || null;
let isAuthenticated = false;
let pendingAuthLaunch: 'signin' | 'signup' | null = null;
let currentSessionId: string | null = null;
// A saved conversation reopened as the current chat. Its tutor context is
// rebuilt on the user's first new turn rather than when the chat merely opens.
let resumableSessionId: string | null = null;
// Tutor replies still streaming, so a reopened chat can tell a reply that is
// still coming from one that was cut off.
const activeChatRequests = new Set<string>();
let pendingTaskLabel: string | null = null;
// The struggle time chosen for the current session. Re-sent whenever sensing
// is reconfigured mid-session so a settings change can't reset it.
let sessionStruggleSeconds = 120;
let gatewayClient: CocoGatewayClient | null = null;

// User messages, tutor replies, and shown suggestions. Each one pushes the
// Judge's next check a full struggle interval out.
const interactions = new InteractionTracker((source) => {
  const sensingPort = process.env.SENSING_PORT || '8080';
  axios
    .post(
      `http://127.0.0.1:${sensingPort}/interaction`,
      { source },
      { timeout: 3000 },
    )
    .catch((err) => {
      log.warn(`[Interaction] failed to post: ${(err as Error).message}`);
    });
});

// Wrap a chat IPC handler so its turn is tracked as an interaction.
let pendingChatRequest: { requestId: string; stopped: boolean } | null = null;
const withTutorTurn =
  <Payload extends { requestId: string }, Result>(
    handler: (event: IpcMainInvokeEvent, payload: Payload) => Promise<Result>,
  ) =>
  (
    event: IpcMainInvokeEvent,
    payload: Payload,
  ): Promise<Result | { error: string }> => {
    if (pendingChatRequest)
      return Promise.resolve({
        error: 'Coco is already working. Stop the current run first.',
      });
    pendingChatRequest = { requestId: payload.requestId, stopped: false };
    personalizationScheduler?.beginInteractiveInference();
    return interactions
      .trackTurn(() => handler(event, payload))
      .finally(() => {
        pendingChatRequest = null;
        personalizationScheduler?.endInteractiveInference();
      });
  };
registerSocialIpcHandlers(ipcMain, new SocialService(() => gatewayClient));
ipcMain.handle('study-access', () => ({
  tutoring_allowed: tutoringAllowed,
  status: studyAccessStatus,
}));
ipcMain.handle('study-refresh-access', async () => {
  await refreshTutoringAccess();
  return { tutoring_allowed: tutoringAllowed, status: studyAccessStatus };
});
ipcMain.handle('study-student-mode', async (_event, enabled?: unknown) => {
  const available =
    currentStudyRole === 'admin' || currentStudyRole === 'super_admin';
  if (typeof enabled === 'boolean') {
    if (!available) throw new Error('Administrator access required.');
    const wasAllowed = tutoringAllowed;
    adminStudentMode = enabled;
    applyEffectiveStudyAccess();
    if (!tutoringAllowed) {
      await stopTutoringForAccess();
    } else if (!wasAllowed) {
      try {
        await configureParticipantRouterCredential();
        if (!cocoSleeping && isOnboardingComplete()) startObserver();
      } catch (error) {
        if (pendingChatRequest) pendingChatRequest.stopped = true;
        void piHarness.abort();
        studyAccessStatus = 'unavailable';
        setTutoringAllowed(false);
        await stopTutoringForAccess();
        throw error;
      }
    }
    createTray();
  }
  return { available, enabled: available && adminStudentMode };
});
const openPersonalization = () => {
  if (!isAuthenticated) return;
  isFloatMode = false;
  showChatPanel({ expanded: true });
  sendToChat('open-personalization-panel', null);
};
ipcMain.on('open-personalization', openPersonalization);

const showPreAssessmentLockedMessage = () => {
  void dialog
    .showMessageBox({
      type: 'info',
      title: 'Finish your pre-assessments first',
      message:
        'Coco chat will unlock after you finish both pre-assessment challenges.',
      detail:
        'Complete Challenge 1 and Challenge 2 in Training to unlock Coco chat, tutoring, and sensing.',
      buttons: ['Open pre-assessments', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) openPersonalization();
    });
};
let currentTutorModelId: string | null = null;
const piHarness = new PiHarness();
const piBridgeToken = randomUUID();

function agentDirectory(sessionId: string | null = currentSessionId): string {
  const conversation = sessionId
    ? readConversations().find((item) => item.sessionId === sessionId)
    : undefined;
  if (conversation?.workingDirectory) return conversation.workingDirectory;
  let directory = path.join(app.getPath('userData'), 'workspace');
  // Older conversations used a single shared folder. Preserve that choice
  // when first opening them; new sessions start in Coco's default workspace.
  if (conversation?.messages.length) {
    try {
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(app.getPath('userData'), 'agent-workspace.json'),
          'utf8',
        ),
      );
      if (typeof saved.directory === 'string' && saved.directory)
        directory = saved.directory;
    } catch {
      /* No legacy folder setting. */
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  if (sessionId) saveConversationDirectory(sessionId, directory);
  return directory;
}

ipcMain.handle(
  'get-agent-workspace',
  (_event, { sessionId }: { sessionId?: string | null } = {}) => ({
    directory: agentDirectory(sessionId),
  }),
);
ipcMain.handle(
  'choose-agent-workspace',
  async (
    _event,
    { sessionId = currentSessionId }: { sessionId?: string | null } = {},
  ) => {
    if (!sessionId)
      throw new Error('Open a conversation before choosing a folder.');
    if (pendingChatRequest)
      throw new Error('Stop the current run before changing folders.');
    const result = await dialog.showOpenDialog({
      title: 'Choose Coco’s working folder',
      defaultPath: agentDirectory(sessionId),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    if (pendingChatRequest)
      throw new Error('Stop the current run before changing folders.');
    const directory = fs.realpathSync(result.filePaths[0]);
    saveConversationDirectory(sessionId, directory);
    return { directory };
  },
);
ipcMain.handle('get-agent-context', (_event, sessionId: string) =>
  typeof sessionId === 'string' ? piHarness.getContextSnapshot(sessionId) : null,
);
ipcMain.handle(
  'answer-agent-question',
  (_event, toolCallId: string, response: unknown) =>
    piHarness.answerQuestion(toolCallId, response),
);
ipcMain.handle('stop-agent-run', (_event, requestId: string) => {
  if (pendingChatRequest?.requestId === requestId)
    pendingChatRequest.stopped = true;
  return piHarness.abort(requestId);
});

// Preserve the original Upskilling session invitation cadence even though the
// sensing-side Judge owns the decision itself.
const TASK_SUGGESTION_COOLDOWN_MS = 5 * 60_000;
let lastTaskSuggestionMs = 0;

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
  serviceManager.configureServiceEnv('tutor-server', {
    ...portEnv,
    COCO_PI_BRIDGE_TOKEN: piBridgeToken,
  });

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

// ── Authentication window ───────────────────────────────────────────────────
// Authentication is checked before models or sensing services start. This
// keeps all locally initiated Gateway writes tied to a verified participant.

const createAuthWindow = () => {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    authWindow.focus();
    return;
  }
  authWindow = new BrowserWindow({
    ...setupWindowOptions(screen.getPrimaryDisplay().workArea),
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
    authWindow?.webContents.send('auth-quit-requested');
  });
};

ipcMain.on('quit-from-auth', (event) => {
  if (event.sender === authWindow?.webContents) app.quit();
});

ipcMain.on('quit-from-avatar', (event) => {
  if (event.sender === avatarWindow?.webContents) app.quit();
});

const readSystemPermissionWarning = () =>
  getSystemPermissionWarning(process.platform, {
    accessibilityTrusted: systemPreferences.isTrustedAccessibilityClient(false),
    screenCaptureStatus: systemPreferences.getMediaAccessStatus('screen'),
  });

const readSystemPermissionHealth = () => {
  const warning = readSystemPermissionWarning();
  return {
    missing: (warning?.settingsTargets ?? []).map((target) => ({
      target,
      label: systemPermissionButtonLabel(target).replace(/^Open /, ''),
      actionLabel: systemPermissionButtonLabel(target),
      explanation: systemPermissionExplanation(target),
    })),
  };
};

ipcMain.handle('get-system-permissions', (event) => {
  if (
    event.sender !== chatWindow?.webContents &&
    event.sender !== onboardingWindow?.webContents
  )
    return { missing: [] };
  return readSystemPermissionHealth();
});
ipcMain.handle('open-system-permissions', async (event, target?: unknown) => {
  if (
    event.sender !== chatWindow?.webContents &&
    event.sender !== onboardingWindow?.webContents
  )
    return { success: false };
  const requestedTarget =
    target === 'accessibility' ||
    target === 'input-monitoring' ||
    target === 'screen-recording'
      ? target
      : undefined;
  try {
    await showSystemPermissionWarning(requestedTarget);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

// ── Onboarding window ─────────────────────────────────────────────────────────
// Shown once on first launch (when coco-profile.json doesn't exist yet).
// Centered modal; after the user completes or skips it, the profile is written
// and the normal avatar + webapp windows are created.

const createOnboardingWindow = (modelsOnly = false) => {
  onboardingWindow = new BrowserWindow({
    ...setupWindowOptions(screen.getPrimaryDisplay().workArea),
    webPreferences: { preload: preloadPath() },
  });

  const url = `${resolveHtmlPath('index.html')}?view=onboarding${
    modelsOnly ? '&modelsOnly=1' : ''
  }${isLlmRouterConfigured() ? '&routerManaged=1' : ''}`;
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
    skipTaskbar: process.platform !== 'darwin',
    webPreferences: { preload: preloadPath() },
  });
  if (process.platform === 'darwin') {
    // The avatar is a companion surface, not a second Coco document. Keep it
    // out of the Dock's window list while the main chat remains listed there.
    avatarWindow.excludedFromShownWindowsMenu = true;
  }
  configureFullscreenCompanionWindow(avatarWindow);

  avatarWindow.loadURL(resolveHtmlPath('index.html'));

  avatarWindow.on('ready-to-show', () => {
    if (hideAvatarMode) {
      avatarWindow?.hide();
    } else if (process.env.START_MINIMIZED) {
      avatarWindow?.minimize();
    } else {
      avatarWindow?.showInactive();
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

// ── Chat window (local tutor session) ─────────────────────────────────────────
// A frameless right-edge side panel hosting the local SessionChatView. Unlike
// the old webapp window there is no WebSocket to keep alive, so it is created on
// demand and hidden (not destroyed) on close so the conversation persists if the
// user reopens it. All chat traffic goes straight to the local tutor server via
// the 'send-chat-message' IPC handler — no external backend involved.

// The chat renderer mounts its IPC listeners shortly after the page loads.
const CHAT_RENDERER_READY_DELAY_MS = 300;
const CHAT_PANEL_W = 520;
const CHAT_EXPANDED_W = 1160;
const CHAT_CONTENT_ZOOM_LEVELS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let chatContentZoomFactor = 1;

const createChatWindow = () => {
  if (chatWindow && !chatWindow.isDestroyed()) return;

  // A fresh renderer hasn't mounted its hot-key listener yet; wait for its
  // readiness handshake before flushing any buffered captures.
  hotkeyRendererReady = false;

  chatWindow = new BrowserWindow({
    show: false,
    width: isFloatMode ? CHAT_PANEL_W : CHAT_EXPANDED_W,
    height: 780,
    minWidth: 420,
    minHeight: 500,
    frame: process.platform === 'darwin',
    transparent: process.platform !== 'darwin',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    resizable: true,
    skipTaskbar: process.platform !== 'darwin',
    alwaysOnTop: false,
    webPreferences: { preload: preloadPath(), backgroundThrottling: false },
  });

  configureMainWindow(chatWindow);
  chatWindow.loadURL(`${resolveHtmlPath('index.html')}?view=session`);

  const reportLayout = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return;
    isFloatMode = chatWindow.getBounds().width < 780;
    chatWindow.webContents.send('float-window-state', { isFloat: isFloatMode });
  };
  chatWindow.on('resize', reportLayout);
  chatWindow.webContents.on('did-finish-load', () => {
    setTimeout(reportLayout, CHAT_RENDERER_READY_DELAY_MS);
  });

  // A recreated chat window starts blank. Give it the current conversation so
  // it doesn't show an empty, task-less chat mid-session.
  chatWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!currentSessionId || !chatWindow || chatWindow.isDestroyed()) return;
      chatWindow.webContents.send('session-init', {
        sessionId: currentSessionId,
        problemStatement: pendingTaskLabel || '',
        tutorModelId: currentTutorModelId,
      });
    }, CHAT_RENDERER_READY_DELAY_MS);
  });
  chatWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(
      `[Chat] Chat renderer exited: ${details.reason} (${details.exitCode})`,
    );
  });

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
    // The chat should only be destroyed on quit; log anything else so it can
    // be traced (it otherwise loses the open conversation).
    if (!isQuitting) log.warn('[Chat] Chat window was destroyed.');
    chatWindow = null;
  });

  chatWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

// ── Proactive suggestions in the chat ─────────────────────────────────────────
// Every shown suggestion becomes a Coco message in the chat: unfolded when the
// chat was already open, folded when it first appeared as a pop-up. It is also
// added to the tutor's history so later replies and the Judge know about it.
const chatSuggestions = new Map<string, ChatSuggestion>();
// The suggestion pop-up currently on screen, if any.
let suggestionNotification: {
  window: BrowserWindow;
  observationId?: string;
} | null = null;

const isChatPanelVisible = (): boolean =>
  chatWindow !== null && !chatWindow.isDestroyed() && chatWindow.isVisible();

// Recreates the (hidden) chat window if it is gone, so nothing is dropped.
const sendToChat = (channel: string, payload: unknown): void => {
  createChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;
  if (chatWindow.webContents.isLoadingMainFrame()) {
    chatWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        chatWindow?.webContents.send(channel, payload);
      }, CHAT_RENDERER_READY_DELAY_MS);
    });
  } else {
    chatWindow.webContents.send(channel, payload);
  }
};

// Deliver a chat stream event to the chat that asked for it, or to its
// replacement if that window was closed mid-reply. Never throws: a missing
// window must not abort the stream, whose outcome main also saves to disk.
const sendChatStreamEvent = (
  sender: WebContents,
  payload: Record<string, unknown>,
): void => {
  let target: WebContents | null = sender;
  if (target.isDestroyed()) {
    target =
      chatWindow && !chatWindow.isDestroyed() ? chatWindow.webContents : null;
  }
  if (!target || target.isDestroyed()) return;
  try {
    target.send('chat-stream-event', payload);
  } catch (err) {
    log.warn(
      `[Chat] Could not deliver stream event: ${(err as Error).message}`,
    );
  }
};

const toChatSuggestion = (
  suggestion: InstantSuggestion,
  observationId?: string,
): ChatSuggestion => {
  const tool =
    suggestion.availableTools?.find((t) => t.id === suggestion.targetTool) ??
    suggestion.availableTools?.[0];
  return {
    observationId,
    kind: suggestion.kind,
    title: suggestion.title,
    body: suggestion.body,
    prompt: suggestion.prompt,
    copyText: suggestion.copyText,
    fourDDimension: suggestion.fourDDimension,
    noticed: suggestion.noticed,
    aiCan: suggestion.aiCan,
    why: suggestion.why,
    check: suggestion.check,
    ...(suggestion.kind === 'delegate' && tool
      ? { tool: { id: tool.id, label: tool.label } }
      : {}),
  };
};

const deliverSuggestionToChat = (
  suggestion: ChatSuggestion,
  folded: boolean,
): void => {
  if (suggestion.observationId) {
    chatSuggestions.set(suggestion.observationId, suggestion);
  }
  log.info(
    `[Suggestion] Added to chat (${folded ? 'folded copy of a pop-up' : 'chat was open'}) id=${suggestion.observationId ?? '(none)'}`,
  );
  sendToChat('chat-suggestion', { suggestion, folded });
};

// Unfold a suggestion in the chat. It carries the suggestion itself so a chat
// window recreated since delivery can still show it.
const revealChatSuggestion = (observationId: string): void => {
  sendToChat('reveal-chat-suggestion', {
    observationId,
    suggestion: chatSuggestions.get(observationId),
  });
};

const recordSuggestionWithTutor = (
  suggestion: ChatSuggestion,
  triggerType?: string,
): void => {
  const tutorPort = process.env.TUTOR_PORT || '8081';
  axios
    .post(
      `http://127.0.0.1:${tutorPort}/context/suggestion`,
      {
        text: chatSuggestionText(suggestion),
        trigger_type: triggerType ?? null,
      },
      { timeout: 3000 },
    )
    .catch((err) => {
      log.warn(
        `[Suggestion] failed to record with tutor: ${(err as Error).message}`,
      );
    });
};

// Position a new chat window once; showing another conversation keeps the
// user's existing window geometry, including when reopening a hidden window.
const showChatPanel = (options: { expanded?: boolean } = {}) => {
  const isNewWindow = !chatWindow || chatWindow.isDestroyed();
  createChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;

  // The pop-up's suggestion is already in the chat; don't show both.
  if (
    suggestionNotification &&
    suggestionNotification.window === notificationWindow &&
    !suggestionNotification.window.isDestroyed()
  ) {
    const { window, observationId } = suggestionNotification;
    suggestionNotification = null;
    window.destroy();
    if (observationId) revealChatSuggestion(observationId);
  }

  if (isNewWindow) {
    const disp = screen.getDisplayMatching(chatWindow.getBounds());
    const { x: dx, y: dy, width: sw, height: sh } = disp.workArea;
    const w = Math.min(isFloatMode ? CHAT_PANEL_W : CHAT_EXPANDED_W, sw - 32);
    const h = Math.min(780, sh - 32);
    chatWindow.setBounds({
      x: dx + sw - w - 16,
      y: dy + Math.floor((sh - h) / 2),
      width: w,
      height: h,
    });
  } else if (options.expanded && chatWindow.getBounds().width < 780) {
    resizeMainWindow(
      chatWindow,
      CHAT_EXPANDED_W,
      screen.getDisplayMatching(chatWindow.getBounds()).workArea,
    );
  }
  configureMainWindow(chatWindow);
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
    skipTaskbar: process.platform !== 'darwin',
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  });
  if (process.platform === 'darwin') {
    imagePreviewWindow.excludedFromShownWindowsMenu = true;
  }
  imagePreviewWindow.setAlwaysOnTop(true, 'floating');
  imagePreviewWindow.loadURL(
    `${resolveHtmlPath('index.html')}?view=image-preview`,
  );
  imagePreviewWindow.on('closed', () => {
    imagePreviewWindow = null;
    imagePreviewDataUrl = null;
  });
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
    skipTaskbar: process.platform !== 'darwin',
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath(),
      backgroundThrottling: false,
    },
  });
  if (process.platform === 'darwin') {
    wakeWordCaptureWindow.excludedFromShownWindowsMenu = true;
  }
  wakeWordCaptureWindow.setIgnoreMouseEvents(true);
  wakeWordCaptureWindow.setAlwaysOnTop(true, 'floating');
  wakeWordCaptureWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Electron otherwise transforms the whole macOS process into an
    // accessory/UIElement app here. Coco keeps running, but the Dock indicator
    // disappears and macOS makes it look as though the app has quit.
    skipTransformProcessType: true,
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
  if (!areRequiredPreAssessmentsComplete()) {
    showPreAssessmentLockedMessage();
    return;
  }
  createChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;

  isFloatMode = false;
  showChatPanel({ expanded: true });
  sendToChat('open-chat-settings', null);
};

// The compact menu lives in the avatar renderer, while Settings lives in the
// chat renderer. Bridge the action through main so the chat becomes visible
// before its renderer is asked to reveal Settings.
ipcMain.removeAllListeners('open-chat-settings');
ipcMain.on('open-chat-settings', () => {
  openChatSettings();
});

async function openCoco(): Promise<void> {
  if (!areRequiredPreAssessmentsComplete()) {
    showPreAssessmentLockedMessage();
    return;
  }
  if (isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, pendingTaskLabel || '');
    return;
  }
  if (currentSessionId) {
    openChatForSession(
      currentSessionId,
      pendingTaskLabel || 'General help session',
    );
    log.info(`[Chat] Reopened existing draft: ${currentSessionId}`);
    return;
  }
  // Return to the most recent conversation rather than a blank chat. Like a
  // draft, it becomes a live session again only once the user sends.
  const latest = latestConversation(readConversations());
  if (latest) {
    currentSessionId = latest.sessionId;
    resumableSessionId = latest.sessionId;
    const modelConfig = readModelConfiguration();
    currentTutorModelId =
      modelConfig?.tutors.find((item) => item.id === latest.tutorModelId)?.id ??
      (modelConfig ? defaultTutor(modelConfig).id : null);
    openChatForSession(latest.sessionId, latest.problem);
    log.info(`[Chat] Reopened latest conversation: ${latest.sessionId}`);
    return;
  }
  // Merely opening the chat feed must not count as a learning session. Give
  // the renderer a draft id so it can render and retain the empty chat; the id
  // is activated and persisted only after the first non-empty user message.
  const problemStatement = pendingTaskLabel || 'General help session';
  const draftSessionId = randomUUID();
  currentSessionId = draftSessionId;
  const modelConfig = readModelConfiguration();
  currentTutorModelId = modelConfig ? defaultTutor(modelConfig).id : null;
  openChatForSession(draftSessionId, problemStatement);
  log.info(`[Chat] Draft opened without starting a session: ${draftSessionId}`);
}

function setupPending(): boolean {
  return (
    !isAuthenticated || !isOnboardingComplete() || !readModelConfiguration()
  );
}

function openPrimaryTrayAction(): void {
  if (!isAuthenticated) {
    createAuthWindow();
    return;
  }
  if (!areRequiredPreAssessmentsComplete()) {
    showPreAssessmentLockedMessage();
    return;
  }
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

// Bring Coco forward when the user asks for it from outside the app: a Dock
// click or reopening the app while it is already running. The chat panel is
// hidden rather than destroyed, so "no window object" can't be the signal.
function revealCoco(): void {
  if (isQuitting) return;
  if (!areRequiredPreAssessmentsComplete()) {
    openPersonalization();
    return;
  }
  if (!setupPending() && !tutoringAllowed) {
    openPersonalization();
    return;
  }
  openPrimaryTrayAction();
}

function handleTrayClick(): void {
  // Preserve the setup-window recovery path, but once setup is complete let
  // the user choose an explicit action instead of opening chat immediately.
  if (!areRequiredPreAssessmentsComplete()) {
    openPersonalization();
    return;
  }
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
  const assessmentLocked = !areRequiredPreAssessmentsComplete();
  const pendingSetup = setupPending() && !assessmentLocked;
  const authRequired = !isAuthenticated;
  let setupLabel = 'Continue Setup';
  if (authRequired) setupLabel = 'Sign in';
  else if (isOnboardingComplete()) setupLabel = 'Open Model Setup';
  const sleeping = isCocoSleeping();
  const showAvatarItems = avatarRecoveryItems(hideAvatarMode, () => {
    const result = updateAvatarVisibilitySetting(false);
    if (!result.success) {
      dialog.showErrorBox(
        'Could not show Coco',
        result.error || 'Please try again.',
      );
    }
  });
  const updateMenuItems: Electron.MenuItemConstructorOptions[] =
    desktopAppUpdater.isSupported()
      ? [
          {
            label: 'Check for Updates…',
            click: () => {
              void desktopAppUpdater.checkForUpdates(true);
            },
          },
        ]
      : [];
  tray.setToolTip(
    pendingSetup ? 'Coco' : `Coco — ${sleeping ? 'Sleeping' : 'Awake'}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate(
      assessmentLocked
        ? [
            ...showAvatarItems,
            {
              label: 'Pre-assessments required',
              enabled: false,
            },
            {
              label: 'Open Pre-assessments…',
              click: openPersonalization,
            },
            ...updateMenuItems,
            { type: 'separator' },
            { label: 'Quit', click: () => app.quit() },
          ]
        : pendingSetup
          ? [
              ...showAvatarItems,
              {
                label: setupLabel,
                click: openPrimaryTrayAction,
              },
              ...updateMenuItems,
              { type: 'separator' },
              { label: 'Quit', click: () => app.quit() },
            ]
          : [
              ...showAvatarItems,
              {
                label: sleeping ? 'Status: Sleeping' : 'Status: Awake',
                enabled: false,
              },
              { type: 'separator' },
              ...cocoNavigationItems({
                'open-main-window': openPrimaryTrayAction,
                'open-chat-settings': openChatSettings,
              }),
              { type: 'separator' },
              {
                label: sleeping ? 'Wake Coco' : 'Sleep',
                click: () => {
                  setCocoSleepMode(!sleeping).catch((err) =>
                    log.warn(`[Tray] Could not change sleep mode: ${err}`),
                  );
                },
              },
              ...updateMenuItems,
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
  createTray();
  if (hidden) {
    avatarWindow?.hide();
    return;
  }
  createAvatarWindow();
  avatarWindow?.show();
}

interface ChatSeed {
  phrase: string;
  label: string;
  rawObservation: string;
  /** Attach context to the user's next turn instead of sending immediately. */
  deferUntilUserMessage?: boolean;
}

// Open the chat panel for a session, pushing the session context (and an
// optional observation to send now or attach to the user's next message).
const openChatForSession = (
  sessionId: string,
  problemStatement: string,
  seed?: ChatSeed,
) => {
  const alreadyLoaded = chatWindow && !chatWindow.isDestroyed();
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
    chatWindow.webContents.once('did-finish-load', () =>
      setTimeout(send, CHAT_RENDERER_READY_DELAY_MS),
    );
  }
};

// Open a conversation surface without starting or recording a session. Any
// suggestion context is held until the user submits their own non-empty turn;
// that first turn then starts a regular `user_message` session.
const openDraftChat = (problemStatement: string, seed?: ChatSeed): string => {
  if (!isSessionActive && currentSessionId) {
    openChatForSession(currentSessionId, problemStatement, seed);
    log.info(`[Chat] Reused existing draft: ${currentSessionId}`);
    return currentSessionId;
  }
  const draftSessionId = randomUUID();
  currentSessionId = draftSessionId;
  const modelConfig = readModelConfiguration();
  currentTutorModelId = modelConfig ? defaultTutor(modelConfig).id : null;
  openChatForSession(draftSessionId, problemStatement, seed);
  log.info(`[Chat] Draft opened without starting a session: ${draftSessionId}`);
  return draftSessionId;
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
    skipTaskbar: process.platform !== 'darwin',
    webPreferences: { preload: preloadPath() },
  });
  if (process.platform === 'darwin') {
    sessionSetupWindow.excludedFromShownWindowsMenu = true;
  }

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

// ── Session-recap floating window ────────────────────────────────────────────
// Generates a local recap from TutorSystem's in-memory conversation history.
// 'check' is the user's own "Check my understanding" quiz, after which the
// session continues; 'end' is the end-of-session recap, which ends it.
type SessionRecapMode = 'check' | 'end';
let sessionRecapMode: SessionRecapMode = 'end';

const showSessionRecapWindow = (
  mode: SessionRecapMode,
  conversation?: StoredConversation,
) => {
  if (!tutoringAllowed) return;
  sessionRecapWindow?.destroy();
  sessionRecapMode = mode;

  const {
    x: dx,
    y: dy,
    width: sw,
    height: sh,
  } = screen.getPrimaryDisplay().workArea;
  const w = 460;
  const h = Math.min(620, sh - 32);

  sessionRecapWindow = new BrowserWindow({
    show: false,
    x: dx + Math.round((sw - w) / 2),
    y: dy + Math.round((sh - h) / 2),
    width: w,
    height: h,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: process.platform !== 'darwin',
    webPreferences: { preload: preloadPath() },
  });
  if (process.platform === 'darwin') {
    sessionRecapWindow.excludedFromShownWindowsMenu = true;
  }

  sessionRecapWindow.loadURL(
    `${resolveHtmlPath('index.html')}?view=session-recap`,
  );

  const tutorPort = process.env.TUTOR_PORT || '8081';
  const recapSessionId = conversation?.sessionId ?? currentSessionId;
  const recapUserId = currentUserId;
  const recapWindow = sessionRecapWindow;
  sessionRecapContext = { sessionId: recapSessionId, userId: recapUserId };
  const recapPromise: Promise<object | null> = axios
    .post(
      `http://127.0.0.1:${tutorPort}/recap`,
      conversation
        ? { messages: restorableMessages(conversation.messages) }
        : {},
      { timeout: 45_000 },
    )
    .then((response) => {
      const data = response.data as object;
      if (recapSessionId && recapUserId) {
        saveLearningRecap(app.getPath('userData'), {
          sessionId: recapSessionId,
          userId: recapUserId,
          generatedAt: Date.now() / 1000,
          recap: data,
        });
      }
      return data;
    })
    .catch((error) => {
      log.warn(`[SessionRecap] Could not generate recap: ${error}`);
      return null;
    });

  recapWindow.on('ready-to-show', async () => {
    recapWindow.show();
    recapWindow.webContents.send('session-recap-init', { mode });
    const data = await recapPromise;
    if (!recapWindow.isDestroyed()) {
      recapWindow.webContents.send('session-recap-data', {
        data,
        error: data === null,
      });
    }
  });

  recapWindow.on('closed', () => {
    if (sessionRecapWindow === recapWindow) {
      sessionRecapWindow = null;
      sessionRecapContext = null;
    }
  });
};

// ── Notification bubble window ────────────────────────────────────────────────
// Notification is pinned to the top-right corner of the primary display so it
// is always fully visible and never clipped by the app window edge.

const NOTIF_WIDTH = 360;
// Keep the card compact; longer Markdown guidance scrolls inside the body.
const NOTIF_HEIGHT = 220;
// Two-page suggestions need enough room for the grounded 4D explanation and
// the prompt/actions on page 2 without requiring manual window resizing.
const NOTIF_SUGGESTION_WIDTH = 480;
const NOTIF_SUGGESTION_HEIGHT = 420;
// Bounds when a suggestion pop-up fits its window to the content.
const NOTIF_SUGGESTION_MIN_HEIGHT = 180;
const NOTIF_SUGGESTION_MAX_HEIGHT = 560;
const NOTIF_DAILY_SUMMARY_WIDTH = 420;
const NOTIF_DAILY_SUMMARY_HEIGHT = 300;
const NOTIF_EXPANDED_WIDTH = 560;
const NOTIF_EXPANDED_HEIGHT = 520;
let notificationCollapsedSize = {
  width: NOTIF_WIDTH,
  height: NOTIF_HEIGHT,
};

type VizState = 'none' | 'success' | 'error';
type NotifType =
  | 'default'
  | 'daily-summary'
  | 'proactive-suggestion'
  | 'instant-suggestion'
  | 'session-start-prompt'
  | 'session-end-prompt';

type NotificationOutcome = 'accepted' | 'dismissed' | 'ignored';

interface ActiveNotificationRecord {
  id: string;
  resolved: boolean;
  created: Promise<void>;
  ignoreTimer?: ReturnType<typeof setTimeout>;
}

let activeNotificationRecord: ActiveNotificationRecord | null = null;

const resolveNotificationRecord = (
  record: ActiveNotificationRecord | null,
  outcome: NotificationOutcome,
) => {
  if (!record || record.resolved) return;
  record.resolved = true;
  if (record.ignoreTimer) clearTimeout(record.ignoreTimer);
  void record.created.then(() =>
    gatewayClient?.resolveNotification(record.id, outcome),
  );
};

const notificationCategory = (notifType: NotifType | undefined): string => {
  switch (notifType) {
    case 'session-start-prompt':
      return 'session_start';
    case 'session-end-prompt':
      return 'session_end';
    case 'proactive-suggestion':
    case 'instant-suggestion':
      return 'proactive_suggestion';
    default:
      return 'general';
  }
};

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
  scenario?: string;
  category?: string;
}): boolean => {
  if (!tutoringAllowed) return false;
  if (postAssessmentActive && payload.category !== 'system') {
    log.info(
      `[Post-assessment] Dropped proactive notification ${payload.notifType ?? payload.category ?? 'general'}`,
    );
    return false;
  }
  if (
    payload.notifType === 'session-end-prompt' &&
    sessionRecapWindow &&
    !sessionRecapWindow.isDestroyed()
  ) {
    log.info(
      '[Notification] Session recap is already open; dropping wrap-up prompt.',
    );
    return false;
  }
  if (proactiveSuggestionOpen) {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      log.info(
        `[Notification] Interactive suggestion is open; dropping ${payload.notifType ?? 'default'} replacement.`,
      );
      return false;
    }
    // Recover from a stale lock if the window disappeared before its closed
    // callback ran. A missing window must never suppress notifications forever.
    proactiveSuggestionOpen = false;
  }
  if (payload.notifType !== 'proactive-suggestion') {
    latestHiddenSuggestionObservationId = undefined;
  }
  if (
    notificationHovered &&
    notificationWindow &&
    !notificationWindow.isDestroyed()
  ) {
    log.info(
      '[Notification] Keeping hovered notification; dropping replacement.',
    );
    return false;
  }
  // Destroy any existing notification before showing a new one (dedup guard).
  notificationHovered = false;
  resolveNotificationRecord(activeNotificationRecord, 'ignored');
  notificationWindow?.destroy();

  const notificationId = randomUUID();
  const shouldPersist = payload.notifType !== 'daily-summary';
  const notificationRecord: ActiveNotificationRecord | null = shouldPersist
    ? {
        id: notificationId,
        resolved: false,
        created:
          gatewayClient?.addNotification({
            id: notificationId,
            category:
              payload.category ?? notificationCategory(payload.notifType),
            notificationType: payload.notifType ?? 'default',
            message: payload.message,
            shownAt: new Date(),
            sessionId:
              isSessionActive && currentSessionId
                ? currentSessionId
                : undefined,
            observationId: payload.observationId,
            actionLabel: payload.actionLabel,
            cancelLabel: payload.cancelLabel,
            status: payload.status,
            fourDDimension: payload.suggestion?.fourDDimension,
            triggerType: payload.suggestion?.triggerType,
          }) ?? Promise.resolve(),
      }
    : null;
  if (notificationRecord) {
    notificationRecord.ignoreTimer = setTimeout(
      () => resolveNotificationRecord(notificationRecord, 'ignored'),
      5 * 60_000,
    );
  }
  activeNotificationRecord = notificationRecord;

  const isInteractiveSuggestion =
    payload.notifType === 'proactive-suggestion' && payload.suggestion != null;
  if (isInteractiveSuggestion) {
    notificationCollapsedSize = {
      width: NOTIF_SUGGESTION_WIDTH,
      height: NOTIF_SUGGESTION_HEIGHT,
    };
  } else if (payload.notifType === 'daily-summary') {
    notificationCollapsedSize = {
      width: NOTIF_DAILY_SUMMARY_WIDTH,
      height: NOTIF_DAILY_SUMMARY_HEIGHT,
    };
  } else {
    notificationCollapsedSize = { width: NOTIF_WIDTH, height: NOTIF_HEIGHT };
  }
  const { width: initialWidth, height: initialHeight } =
    notificationCollapsedSize;
  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - initialWidth - 16;
  const y = workArea.y + 16;
  const adjustable = hideAvatarMode || payload.notifType === 'daily-summary';

  const nextNotificationWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: initialWidth,
    height: initialHeight,
    transparent: true,
    frame: false,
    // The card draws its own CSS shadow; the native one would outline the
    // full transparent window bounds, including space below compact cards.
    hasShadow: false,
    alwaysOnTop: true,
    resizable: adjustable,
    minimizable: false,
    maximizable: false,
    minWidth: adjustable ? 320 : undefined,
    minHeight: adjustable ? 180 : undefined,
    skipTaskbar: process.platform !== 'darwin',
    webPreferences: { preload: preloadPath() },
  });
  if (process.platform === 'darwin') {
    nextNotificationWindow.excludedFromShownWindowsMenu = true;
  }
  configureFullscreenCompanionWindow(nextNotificationWindow);
  notificationWindow = nextNotificationWindow;

  // AI-upskilling suggestions open directly on the interactive framework
  // overview. Lock from the first page—not only after the user advances—so a
  // later observation cannot replace the card while it is being read/rendered.
  if (
    payload.notifType === 'proactive-suggestion' &&
    payload.scenario === 'ai_upskilling' &&
    payload.suggestion
  ) {
    proactiveSuggestionOpen = true;
  }

  const url = `${resolveHtmlPath('index.html')}?view=notification`;
  nextNotificationWindow.loadURL(url);

  nextNotificationWindow.on('ready-to-show', () => {
    if (notificationWindow !== nextNotificationWindow) return;
    nextNotificationWindow.showInactive();
    nextNotificationWindow.webContents.send('notification', {
      ...payload,
      notificationId: shouldPersist ? notificationId : undefined,
      adjustable,
    });
  });

  nextNotificationWindow.on('closed', () => {
    resolveNotificationRecord(notificationRecord, 'ignored');
    // An older window can finish closing after its replacement was assigned.
    // Only the window that still owns the slot may clear the active lock.
    if (notificationWindow !== nextNotificationWindow) return;
    notificationWindow = null;
    if (activeNotificationRecord === notificationRecord) {
      activeNotificationRecord = null;
    }
    notificationHovered = false;
    proactiveSuggestionOpen = false;
  });
  return true;
};

// ── IPC handlers ──────────────────────────────────────────────────────────────
// Use removeAllListeners before each .on() so hot-reloads in development never
// accumulate duplicate handlers (which would fire multiple notifications).

// ── Onboarding ────────────────────────────────────────────────────────────────

// The allowlist is embedded in services/config.json when packaging. Both the
// onboarding and Settings renderers use this value, while the main process also
// enforces it before persisting or applying a scenario.
ipcMain.handle('get-supported-modes', () => serviceManager.getSupportedModes());

const allowedScenario = (value: unknown): AgentModeId => {
  const supportedModes = serviceManager.getSupportedModes();
  return typeof value === 'string' &&
    supportedModes.includes(value as AgentModeId)
    ? (value as AgentModeId)
    : supportedModes[0];
};

const sanitizeProfileMode = (profile: object): Record<string, unknown> => {
  const next = { ...(profile as Record<string, unknown>) };
  next.tutorScenario = allowedScenario(next.tutorScenario);
  if (next.tutorScenario !== 'custom') next.customSystemPrompt = '';
  return next;
};

// Returns the saved onboarding profile so renderer/webapp code can read it
// without needing filesystem access. Returns null if the profile doesn't exist.
ipcMain.handle('get-profile', () => {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf-8');
    const profile = JSON.parse(raw);
    if (!currentUserId || profile?.participantId !== currentUserId) return null;
    return sanitizeProfileMode(profile);
  } catch {
    return null;
  }
});

ipcMain.removeAllListeners('notification-response');
ipcMain.on(
  'notification-response',
  (
    _event,
    payload: { notificationId?: string; outcome?: NotificationOutcome },
  ) => {
    if (
      !payload?.notificationId ||
      payload.notificationId !== activeNotificationRecord?.id ||
      !['accepted', 'dismissed', 'ignored'].includes(payload.outcome ?? '')
    ) {
      return;
    }
    resolveNotificationRecord(
      activeNotificationRecord,
      payload.outcome as NotificationOutcome,
    );
  },
);

ipcMain.handle('get-chat-content-zoom-factor', () => chatContentZoomFactor);

// Model/provider configuration is owned by the main process. The renderer sees
// only masked credential status; plaintext keys are accepted on save and never
// returned over IPC.
ipcMain.handle('get-model-configuration', () => getModelConfigurationView());
ipcMain.handle('get-llm-router-status', () => ({
  configured: isLlmRouterConfigured(),
  url: process.env.LLM_ROUTER_URL?.trim() || '',
}));

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
    // Sleep mode intentionally stops the sensing and tutor services. Do not
    // report their expected absence as a health failure.
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
  if (!tutoringAllowed)
    return {
      success: false,
      error: 'AI tutoring is disabled for this account.',
    };
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
      { messages: restorableMessages(conversation.messages) },
      { timeout: 8000 },
    );
  }
  await axios.post(
    `${sensing}/session`,
    {
      node_uuid: currentSessionId,
      struggle_detection_seconds: sessionStruggleSeconds,
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
        personalizationScheduler?.updateModelConfiguration(runtime.config.sensing.model, runtime.sensingEnv);
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
    const participantProfile = {
      ...(profile as Record<string, unknown>),
      participantId: currentUserId,
      ...(app.isPackaged
        ? { onboardingVersion: PACKAGED_ONBOARDING_VERSION }
        : {}),
    };
    fs.writeFileSync(
      profilePath(),
      JSON.stringify(sanitizeProfileMode(participantProfile), null, 2),
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
    const participantProfile = {
      ...(profile as Record<string, unknown>),
      participantId: currentUserId,
      ...(app.isPackaged
        ? { onboardingVersion: PACKAGED_ONBOARDING_VERSION }
        : {}),
    };
    fs.writeFileSync(
      profilePath(),
      JSON.stringify(sanitizeProfileMode(participantProfile), null, 2),
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

    // Pre-session: opening help is not acceptance of a coaching session. Keep
    // the observation as context for the user's first actual message.
    const problemStatement =
      payload?.phrase?.trim() ||
      payload?.label?.trim() ||
      pendingTaskLabel ||
      'General help session';
    openDraftChat(problemStatement, {
      ...payload,
      deferUntilUserMessage: true,
    });
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
      });

    if (isSessionActive && currentSessionId) {
      openChatForSession(currentSessionId, pendingTaskLabel || '', seed);
    } else {
      openDraftChat(rawObservation || 'General help session', {
        ...seed,
        deferUntilUserMessage: true,
      });
    }
  },
);

// Forward an explicit user reaction (bubble engage/dismiss) to the sensing
// server's /feedback endpoint, which logs it into the shared training data.
ipcMain.removeAllListeners('training-feedback');
ipcMain.on('training-feedback', async (_event, payload) => {
  personalizationScheduler?.noteFeedback();
  try {
    const sensingPort = process.env.SENSING_PORT || '8080';
    await axios.post(
      `http://127.0.0.1:${sensingPort}/feedback`,
      payload ?? {},
      {
        timeout: 3000,
      },
    );
  } catch (err) {
    log.warn(
      `[Feedback] failed to post: ${(err as { message?: string })?.message}`,
    );
  }
});

function publishCocoSleepMode() {
  const state = { sleeping: isCocoSleeping() };
  avatarWindow?.webContents.send('coco-sleep-mode-changed', state);
  chatWindow?.webContents.send('coco-sleep-mode-changed', state);
  wakeWordCaptureWindow?.webContents.send('coco-sleep-mode-changed', state);
  if (tray && !tray.isDestroyed()) createTray();
  return state;
}

function setTutoringAllowed(allowed: boolean) {
  const wasSleeping = isCocoSleeping();
  tutoringAllowed = allowed;
  process.env.COCO_TUTORING_ALLOWED = allowed ? '1' : '0';
  if (isCocoSleeping() !== wasSleeping) publishCocoSleepMode();
}

if (app.isPackaged && !(process.env.COLLECT_TRAINING_SCREENSHOTS ?? '').trim()) {
  process.env.COLLECT_TRAINING_SCREENSHOTS = '1';
}

const trainingScreenshotRetentionEnabled = () =>
  ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECT_TRAINING_SCREENSHOTS ?? '').trim().toLowerCase(),
  );

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

ipcMain.removeHandler('get-personalization-center');
ipcMain.handle('get-personalization-center', () => {
  initializeDailyMemoryDraftService();
  const dailyRun = eveningPersonalizationScheduler?.getStatus() ?? {
    scheduledHour: 18,
  };
  return {
    status: {
      ...(personalizationScheduler?.getStatus() ?? {
        available: false,
        sleeping: isCocoSleeping(),
        successfulUpdateCount: 0,
        state: 'idle',
      }),
      dailyRun,
    },
    center: personalizationCenterService?.snapshot() ?? null,
  };
});

ipcMain.removeHandler('save-personalization-review-decision');
ipcMain.handle('save-personalization-review-decision', (_event, input) => {
  try {
    initializeDailyMemoryDraftService();
    return {
      success: true,
      center: personalizationCenterService?.saveDecision(input) ?? null,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.removeHandler('apply-personalization-review');
ipcMain.handle(
  'apply-personalization-review',
  async (_event, { draftId }: { draftId?: string } = {}) => {
    if (!draftId) return { success: false, error: 'Draft ID is required.' };
    try {
      initializeDailyMemoryDraftService();
      if (!personalizationCenterService) {
        throw new Error('Personalization review is not available.');
      }
      const { memory, draft } =
        personalizationCenterService.applyReview(draftId);
      const tutorPort = process.env.TUTOR_PORT || '8081';
      try {
        await axios.post(
          `http://127.0.0.1:${tutorPort}/context/evolved_memory`,
          { memory },
          { timeout: 8000 },
        );
      } catch (error) {
        log.warn(
          `[Memory] personalization review live apply failed: ${(error as Error).message}`,
        );
      }
      avatarWindow?.webContents.send('daily-memory-draft-applied', {
        draftId: draft.draftId,
      });
      return { success: true, draftId: draft.draftId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
);


ipcMain.removeHandler('get-coco-sleep-mode');
ipcMain.handle('get-coco-sleep-mode', () => ({
  sleeping: isCocoSleeping(),
}));

async function setCocoSleepMode(sleeping: boolean, { wakeAfterPersonalization = false } = {}) {
  wakeAfterEveningPersonalization = wakeAfterPersonalization;
  cocoSleeping = sleeping;
  personalizationScheduler?.setSleepMode(sleeping);
  publishCocoSleepMode();
  syncWakeWordService();
  if (sleeping) {
    await serviceManager.stopService('sensing-server');
    serviceManager.startService('tutor-server');
  } else if (observerStarted) {
    await serviceManager.startAll();
  } else if (isOnboardingComplete()) {
    startObserver();
  }
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
  const payload = {
    message,
    actionLabel: 'Open Coco',
  };
  const shown = showNotification(payload);
  log.info('[Evening] Coco entered sleep mode for personalization.');
  return shown;
}

ipcMain.removeHandler('set-coco-sleep-mode');
ipcMain.handle(
  'set-coco-sleep-mode',
  async (_event, { sleeping }: { sleeping?: boolean } = {}) => {
    if (typeof sleeping !== 'boolean') {
      return { success: false, error: 'Invalid sleep mode.' };
    }
    try {
      return await setCocoSleepMode(sleeping);
    } catch (error) {
      log.error('[Sleep] Could not change Coco sleep mode:', error);
      return {
        success: false,
        sleeping: isCocoSleeping(),
        error: (error as Error).message,
      };
    }
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
    if (
      enabled &&
      process.platform === 'win32' &&
      needsWindowsMicrophoneSettings(
        process.platform,
        systemPreferences.getMediaAccessStatus('microphone'),
      )
    ) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Microphone permission required',
        message: 'Coco needs microphone access for voice activation.',
        detail:
          'Enable microphone access for desktop apps in Windows Settings, then turn “Listen for Coco” on again.',
        buttons: ['Open Microphone Settings', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) {
        await shell.openExternal('ms-settings:privacy-microphone');
      }
      return {
        success: false,
        error:
          'Microphone access is required. Enable microphone access for desktop apps in Windows Settings.',
      };
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
    category: 'tutor_guidance',
  });
});

ipcMain.removeAllListeners('notification-hover-state');
ipcMain.on(
  'notification-hover-state',
  (_event, { hovered }: { hovered?: boolean }) => {
    notificationHovered = hovered === true;
  },
);

ipcMain.removeAllListeners('proactive-suggestion-open-state');
ipcMain.on(
  'proactive-suggestion-open-state',
  (_event, { open }: { open?: boolean }) => {
    proactiveSuggestionOpen = open === true;
  },
);

ipcMain.removeAllListeners('set-notification-expanded');
ipcMain.on(
  'set-notification-expanded',
  (_event, { expanded }: { expanded?: boolean }) => {
    if (
      !notificationWindow ||
      notificationWindow.isDestroyed() ||
      !notificationWindow.isResizable()
    ) {
      return;
    }

    const current = notificationWindow.getBounds();
    const display = screen.getDisplayMatching(current);
    const targetWidth = expanded
      ? NOTIF_EXPANDED_WIDTH
      : notificationCollapsedSize.width;
    const targetHeight = expanded
      ? NOTIF_EXPANDED_HEIGHT
      : notificationCollapsedSize.height;
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

// AI-upskilling suggestion pages ask for a window height that fits their card.
// Only the top edge stays put, so the pop-up grows or shrinks downward.
ipcMain.removeAllListeners('fit-notification-height');
ipcMain.on(
  'fit-notification-height',
  (event, { height }: { height?: unknown } = {}) => {
    if (
      !notificationWindow ||
      notificationWindow.isDestroyed() ||
      event.sender !== notificationWindow.webContents ||
      typeof height !== 'number' ||
      !Number.isFinite(height)
    ) {
      return;
    }
    const current = notificationWindow.getBounds();
    const { workArea } = screen.getDisplayMatching(current);
    const maxHeight = Math.min(
      NOTIF_SUGGESTION_MAX_HEIGHT,
      workArea.y + workArea.height - current.y,
    );
    const fitted = Math.round(
      Math.max(NOTIF_SUGGESTION_MIN_HEIGHT, Math.min(height, maxHeight)),
    );
    if (fitted !== current.height) {
      notificationWindow.setBounds({ ...current, height: fitted });
    }
  },
);

// ── Chat-panel width toggle ────────────────────────────────────────────────────
// The renderer sends this when the user clicks the expand / collapse button to
// switch the chat between the narrow side panel and a wider reading width.
ipcMain.removeAllListeners('toggle-float-window');
ipcMain.on(
  'toggle-float-window',
  (_event, options?: { expanded?: boolean }) => {
    if (!chatWindow || chatWindow.isDestroyed()) return;
    const nextFloatMode =
      typeof options?.expanded === 'boolean' ? !options.expanded : !isFloatMode;
    if (nextFloatMode !== isFloatMode) {
      isFloatMode = nextFloatMode;
      resizeMainWindow(
        chatWindow,
        isFloatMode ? CHAT_PANEL_W : CHAT_EXPANDED_W,
        screen.getDisplayMatching(chatWindow.getBounds()).workArea,
      );
    }
    chatWindow.webContents.send('float-window-state', { isFloat: isFloatMode });
  },
);

// The chat's close button. Closing from main emits the window's 'close' event,
// which hides the chat (keeping its conversation and any streaming reply)
// rather than destroying it as a renderer-side window.close() would.
ipcMain.removeAllListeners('close-chat-window');
ipcMain.on('close-chat-window', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
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
  let scenario: string = allowedScenario(undefined);
  let customObserverPrompt = '';
  let userName = '';
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
    scenario = allowedScenario(profile.tutorScenario);
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
  fourDDimension?: 'delegation' | 'description' | 'discernment' | 'diligence';
  teachingDepth?: 'introduce' | 'reinforce' | 'deepen';
  /** One-sentence explanation shown before the suggestion's action. */
  noticed?: string;
  aiCan?: string;
  why?: string;
  check?: string;
  triggerType?: string;
  interventionSource?: 'judge' | 'observer';
}

// Suggestions the writer declined, so a click reports why nothing is ready.
const abstainedSuggestionIds = new Set<string>();
const suggestionCache = new Map<
  string,
  { ts: number; promise: Promise<InstantSuggestion | null> }
>();
const loggedProactiveSuggestions = new Set<string>();
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
  'support_needed',
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'discernment_opportunity',
]);
// Build the list of Open buttons for a delegate suggestion from the user's
// selected tools. The model's chosen tool (`preferredId`) implies whether the
// task calls for a chatbot or an agent. Return only the best matching tool so
// the suggestion never presents a stack of competing "Open" actions. Falls
// back to the first selected tool — then ChatGPT — if that category has none.
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
  return list.slice(0, 1).map((t) => ({
    id: t.id,
    label: t.label,
    category: t.category,
  }));
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
  intervention_source?: 'judge';
  trigger_type?: string;
  teaching_depth?: 'introduce' | 'reinforce' | 'deepen' | 'not_applicable';
}): Promise<InstantSuggestion | null> | undefined {
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
      },
      { timeout: SUGGESTION_REQUEST_TIMEOUT_MS },
    )
    .then((resp) => {
      if ((resp.data as { kind?: string }).kind === 'abstain') {
        // The suggestion writer found nothing worth showing. Show nothing, and
        // tell sensing so the Judge and observer learn this moment didn't fit.
        abstainedSuggestionIds.add(id);
        log.info(
          `[InstantSuggestion] abstained id=${id} in ${Date.now() - startedAt}ms`,
        );
        const sensingPort = process.env.SENSING_PORT || '8080';
        axios
          .post(
            `http://127.0.0.1:${sensingPort}/feedback`,
            {
              kind: 'abstain',
              surface: hideAvatarMode ? 'notification' : 'bubble',
              observation_id: id,
              status: event.status ?? null,
              text: 'No useful AI-skills suggestion fit this moment.',
            },
            { timeout: 3000 },
          )
          .catch((err) => {
            log.warn(
              `[Feedback] failed to post abstention: ${(err as Error).message}`,
            );
          });
        return null;
      }
      const data = {
        ...(resp.data as InstantSuggestion),
        triggerType: event.trigger_type ?? event.status,
        teachingDepth:
          (resp.data as InstantSuggestion).teachingDepth ??
          (event.teaching_depth === 'not_applicable'
            ? undefined
            : event.teaching_depth),
        interventionSource:
          event.intervention_source === 'judge' ? 'judge' : 'observer',
      } as InstantSuggestion;
      recordSupportSuggestion(id, data);
      log.info(
        `[InstantSuggestion] precompute ready id=${id} kind=${data?.kind} in ${Date.now() - startedAt}ms`,
      );
      return data;
    })
    .catch((err) => {
      log.warn(
        `[InstantSuggestion] precompute failed for ${id} after ${Date.now() - startedAt}ms: ${(err as { message?: string })?.message}`,
      );
      return null;
    });
  void promise.finally(() => personalizationScheduler?.endInteractiveInference());
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
    if (!tutoringAllowed || postAssessmentActive) return { status: 'missing' };
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
      return {
        status: abstainedSuggestionIds.has(observationId!)
          ? 'abstained'
          : 'error',
      };
    }
    // Attach only the best matching tool so the delegate bubble has one clear
    // Open action.
    const suggestion: InstantSuggestion =
      value.kind === 'delegate'
        ? { ...value, availableTools: buildAvailableTools(value.targetTool) }
        : value;
    return {
      status: 'ready',
      suggestion,
      scenario: readProfile().scenario,
    };
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
    { toolId, copyText }: { toolId?: string | null; copyText?: string },
  ) => {
    if (copyText) clipboard.writeText(copyText);
    if (toolId) openAiTool(toolId);
  },
);

// "Ask Coco about it": open a revealed suggestion in Coco's conversation. If it
// isn't already in the chat, attach it and its observation as context for the
// user's next message.
ipcMain.removeAllListeners('chat-about-suggestion');
ipcMain.on(
  'chat-about-suggestion',
  async (
    _event,
    payload: {
      execute?: boolean;
      observationId?: string;
      status?: string;
      rawObservation?: string;
      suggestion?: InstantSuggestion;
      surface?: 'bubble' | 'notification';
    },
  ) => {
    if (payload?.surface === 'notification') notificationWindow?.destroy();

    const suggestion = payload?.suggestion;
    if (!suggestion) return;
    const rawObservation = payload.rawObservation?.trim() || '';
    const suggestionText =
      suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body;
    const seed: ChatSeed = {
      phrase: suggestion.title,
      label: payload.status?.replace(/_/g, ' ') || 'suggestion',
      rawObservation: [
        payload.execute
          ? 'Carry out this suggestion for me:'
          : 'I’d like to chat about this suggestion:',
        `**${suggestion.title}**`,
        suggestionText || suggestion.copyText,
        rawObservation ? `Context that prompted it:\n${rawObservation}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      deferUntilUserMessage: !payload.execute,
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
      });

    // A pop-up suggestion is already in the chat and the tutor's history, so
    // open it there rather than attaching it again as hidden context.
    if (payload.observationId && chatSuggestions.has(payload.observationId)) {
      // Re-send the session too, in case the chat window was recreated.
      if (isSessionActive && currentSessionId) {
        openChatForSession(currentSessionId, pendingTaskLabel || '');
      } else {
        showChatPanel();
      }
      revealChatSuggestion(payload.observationId);
      return;
    }
    if (isSessionActive && currentSessionId) {
      openChatForSession(currentSessionId, pendingTaskLabel || '', seed);
    } else {
      openDraftChat(suggestion.title, seed);
    }
  },
);

// Create a tutor session entirely against the LOCAL servers (no backend). A
// "session" here is just a fresh conversation on the tutor server plus a
// configured struggle-detection window on the sensing server. Shared by the
// explicit "Yes, start session" flow and user-message session activation.
// Returns the new (locally generated) session id, or null on failure.
async function createProactiveTutorSession(
  problemStatement: string,
  struggleSeconds: number,
  startTrigger: SessionStartTrigger,
  seed?: ChatSeed,
  options: { sessionId?: string; openChat?: boolean } = {},
): Promise<string | null> {
  if (!tutoringAllowed) return null;
  // Read the user's onboarding profile to get their selected AI tools and mode.
  const { aiTools, scenario, customObserverPrompt, userName } = readProfile();

  const sensingPort = process.env.SENSING_PORT || '8080';
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const sensing = `http://127.0.0.1:${sensingPort}`;
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const sessionId = options.sessionId ?? randomUUID();
  const modelConfig = readModelConfiguration();
  const selectedTutor = modelConfig ? defaultTutor(modelConfig) : null;
  currentTutorModelId = selectedTutor?.id ?? null;

  // Open the chat panel immediately so the user always gets a UI, even if a
  // server is still starting up. Configuration below is best-effort.
  currentSessionId = sessionId;
  isSessionActive = true;
  pendingTaskLabel = problemStatement;
  sessionStruggleSeconds = struggleSeconds;
  if (options.openChat !== false) {
    openChatForSession(sessionId, problemStatement, seed);
  }
  log.info(`[ProactiveSession] Local tutor session started: ${sessionId}`);
  const startedAt = new Date();
  recordSessionStarted(
    sessionId,
    currentUserId,
    startTrigger,
    startedAt,
    problemStatement,
  );
  gatewayClient?.startSession(
    sessionId,
    startTrigger,
    startedAt,
    problemStatement,
  );

  const sessionStillActive = () =>
    isSessionActive &&
    currentSessionId === sessionId &&
    !(options.openChat === false && pendingChatRequest?.stopped);
  const retryLocalPost = async (
    label: string,
    url: string,
    body: unknown,
    timeout: number,
  ) =>
    retryOperation(() => axios.post(url, body, { timeout }), {
      shouldContinue: sessionStillActive,
      onRetry: (error, nextDelayMs, failedAttempt) => {
        log.warn(
          `[ProactiveSession] ${label} attempt ${failedAttempt} failed; retrying in ${nextDelayMs}ms: ${(error as Error).message}`,
        );
      },
    });

  // Register sensing first. Its /session handler resets TutorSystem, so doing
  // this after tutor context setup would erase the current problem statement.
  try {
    if (!isCocoSleeping()) await retryLocalPost(
      'Sensing session setup',
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
      15000,
    );
  } catch (err) {
    if (!(err instanceof RetryCancelledError)) {
      log.warn(
        `[ProactiveSession] Sensing session setup failed after retries (proactive disabled): ${(err as Error).message}`,
      );
    }
  }

  // Configure TutorSystem after sensing registration so the final context
  // always contains this session's task, tools, scenario, and memory.
  try {
    await retryLocalPost('Tutor reset', `${tutor}/context/reset`, {}, 8000);
    if (selectedTutor) {
      await retryLocalPost(
        'Tutor model setup',
        `${tutor}/config/model`,
        { model: selectedTutor.model },
        8000,
      );
    }
    await retryLocalPost(
      'Tutor scenario setup',
      `${tutor}/config/scenario`,
      { scenario },
      8000,
    );
    await retryLocalPost(
      'Tutor problem statement setup',
      `${tutor}/context/problem_statement`,
      { problem_statement: problemStatement },
      8000,
    );
    await retryLocalPost(
      'Tutor AI tools setup',
      `${tutor}/context/ai_tools`,
      { ai_tools: aiTools },
      8000,
    );
    // Re-apply the persisted long-term memory so a freshly (re)started tutor
    // process always has it, independent of its own on-disk load.
    const savedMemory = readLocalMemory();
    if (savedMemory) {
      await retryLocalPost(
        'Tutor memory setup',
        `${tutor}/context/memory`,
        { memory: savedMemory },
        8000,
      );
    }
  } catch (err) {
    if (!(err instanceof RetryCancelledError)) {
      log.warn(
        `[ProactiveSession] Tutor context setup failed after retries: ${(err as Error).message}`,
      );
    }
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
        'user_message',
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
ipcMain.handle('get-chat-conversations', () =>
  readConversations()
    .filter((conversation) => conversation.messages.length > 0)
    .map((conversation) =>
      interruptStaleReplies(conversation, (requestId) =>
        activeChatRequests.has(requestId),
      ),
    ),
);

ipcMain.removeHandler('save-chat-conversation');
ipcMain.handle('save-chat-conversation', (_event, payload) => {
  saveConversation({ ...(payload ?? {}), tutorModelId: currentTutorModelId });
  return { success: true };
});

// Rebuild tutor context for a saved conversation and make it the live one.
// Continuing a conversation is not a new learning session, so this does not
// record a session start.
async function resumeSavedConversation(
  conversation: StoredConversation,
  excludeTrailingUserText?: string,
): Promise<{ success: boolean; tutorModelId?: string | null; error?: string }> {
  const tutorPort = process.env.TUTOR_PORT || '8081';
  const tutor = `http://127.0.0.1:${tutorPort}`;
  const { aiTools, scenario, userName } = readProfile();
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
        messages: restorableMessages(
          conversation.messages,
          excludeTrailingUserText,
        ),
      },
      { timeout: 8000 },
    );
    currentSessionId = conversation.sessionId;
    isSessionActive = true;
    pendingTaskLabel = conversation.problem;
    resumableSessionId = null;
    // Continuing an ended conversation from history makes it current again.
    setConversationEnded(conversation.sessionId, false);
    return { success: true, tutorModelId: currentTutorModelId };
  } catch (err) {
    log.warn(`[Chat] Could not resume conversation: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

// Resume the reopened conversation before the user's first new turn in it, so
// the tutor sees its history. Returns false when there is nothing to resume.
async function resumeReopenedConversation(userText?: string): Promise<boolean> {
  if (isSessionActive || !resumableSessionId) return false;
  if (resumableSessionId !== currentSessionId) {
    resumableSessionId = null;
    return false;
  }
  const conversation = readConversations().find(
    (saved) => saved.sessionId === resumableSessionId,
  );
  resumableSessionId = null;
  if (!conversation) return false;
  return (await resumeSavedConversation(conversation, userText)).success;
}

ipcMain.removeHandler('resume-chat-conversation');
ipcMain.handle(
  'resume-chat-conversation',
  async (_event, { sessionId }: { sessionId?: string } = {}) => {
    if (pendingChatRequest)
      return {
        success: false,
        error: 'Stop the current run before switching conversations.',
      };
    const conversation = readConversations().find(
      (saved) => saved.sessionId === sessionId,
    );
    if (!conversation) {
      return { success: false, error: 'Conversation not found.' };
    }
    return resumeSavedConversation(conversation);
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
      'proactive_suggestion',
    );
  },
);

// User clicked "Yes" in the "task done?" notification — show the local recap.
ipcMain.removeAllListeners('proactive-session-end-confirmed');
ipcMain.on('proactive-session-end-confirmed', () => {
  notificationWindow?.destroy();
  chatWindow?.hide();
  showSessionRecapWindow('end');
});

// Understanding checks use a transcript snapshot; they never activate, resume,
// or finish a session, including when the user is reviewing an archived chat.
ipcMain.removeHandler('check-understanding');
ipcMain.handle(
  'check-understanding',
  (_event, { sessionId }: { sessionId?: string | null } = {}) => {
    if (pendingChatRequest)
      return {
        success: false,
        error: 'Wait for Coco to finish before checking your understanding.',
      };
    if (!tutoringAllowed)
      return {
        success: false,
        error: 'AI tutoring is not available for this account.',
      };
    if (readProfile().scenario !== 'ai_upskilling')
      return {
        success: false,
        error: 'Understanding checks are unavailable in this mode.',
      };
    const targetId = sessionId ?? currentSessionId;
    const conversation = readConversations().find(
      (saved) => saved.sessionId === targetId,
    );
    if (
      !conversation ||
      !restorableMessages(conversation.messages).some((message) =>
        message.text.trim(),
      )
    ) {
      return {
        success: false,
        error:
          'Have a conversation with Coco first, then check your understanding.',
      };
    }
    showSessionRecapWindow('check', conversation);
    return { success: true };
  },
);

// The user answered or skipped the recap. An understanding check returns to
// the same session; the end-of-session recap gives the session-level quiz
// result and tears the session down.
ipcMain.removeAllListeners('session-recap-done');
ipcMain.on('session-recap-done', (event, payload?: unknown) => {
  if (event.sender !== sessionRecapWindow?.webContents) return;
  const recap = sessionRecapContext;
  const result =
    payload && typeof payload === 'object'
      ? (payload as {
          quizAnswered?: unknown;
          quizCorrect?: unknown;
          selectedIndex?: unknown;
        })
      : {};
  if (recap?.sessionId) {
    const quizAnswered = result.quizAnswered === true;
    const completion = {
      // Treat missing/older renderer payloads as skipped too, so every recap
      // completion has an unambiguous quiz outcome.
      quizSkipped: !quizAnswered,
      quizAnswered,
      ...(quizAnswered && typeof result.quizCorrect === 'boolean'
        ? { quizCorrect: result.quizCorrect }
        : {}),
      ...(quizAnswered && typeof result.selectedIndex === 'number'
        ? { selectedIndex: result.selectedIndex }
        : {}),
    };
    if (sessionRecapMode === 'check') {
      recordUnderstandingChecked(recap.sessionId, recap.userId, completion);
    } else {
      const endedAt = new Date();
      recordSessionEnded(recap.sessionId, recap.userId, completion, endedAt);
      gatewayClient?.endSession(recap.sessionId, {
        endedAt,
        recapCompletedAt: endedAt,
        ...completion,
      });
      // Reopening Coco after an ended session starts a new conversation.
      setConversationEnded(recap.sessionId, true);
    }
  }
  sessionRecapWindow?.destroy();
  if (sessionRecapMode === 'check') {
    showChatPanel();
    return;
  }
  if (recap?.sessionId === currentSessionId) endCurrentSession();
});

// Ends the active session: mark inactive, close the chat panel, and tell the
// sensing server to revert to pre-session observation mode.
function endCurrentSession() {
  if (pendingChatRequest) pendingChatRequest.stopped = true;
  void piHarness.abort();
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
// Chat requests run in a persistent pi session. The local tutor service supplies
// the configured model, profile context, and existing screen/memory tools.
// Images stay as data URLs; execution events stream back to the renderer.
ipcMain.removeHandler('send-chat-message');
ipcMain.handle(
  'send-chat-message',
  withTutorTurn(
    async (
      ipcEvent,
      {
        requestId,
        userText,
        displayText,
        isRetry,
        images,
        requestKind,
        hotkeyImages,
      }: {
        requestId: string;
        userText: string;
        displayText?: string;
        isRetry?: boolean;
        images?: string[];
        requestKind?: 'chat' | 'practice_suggestions';
        hotkeyImages?: string[];
      },
    ) => {
      if (piHarness.busy)
        return {
          error: 'Coco is already working. Stop the current run first.',
        };
      const tutorPort = process.env.TUTOR_PORT || '8081';
      const tutor = `http://127.0.0.1:${tutorPort}`;
      const sessionStartText = (displayText ?? userText).trim();
      if (!tutoringAllowed)
        return { error: 'AI tutoring is disabled for this account.' };
      await resumeReopenedConversation(displayText ?? userText);
      if (
        !isSessionActive &&
        shouldStartSessionFromUserMessage(
          sessionStartText,
          requestKind ?? 'chat',
        )
      ) {
        // Reuse the draft id already known by the renderer. Suppressing another
        // session-init event prevents the first optimistic message from being
        // cleared while this request is in flight.
        await createProactiveTutorSession(
          sessionStartText,
          120,
          'user_message',
          undefined,
          {
            sessionId: currentSessionId ?? undefined,
            openChat: false,
          },
        );
      }
      const gatewaySessionId = currentSessionId;
      if (!isRetry && gatewaySessionId) {
        gatewayClient?.addMessage(
          gatewaySessionId,
          'user',
          displayText ?? userText,
        );
      }

      const hotkeyImageSet = new Set(hotkeyImages ?? []);
      const hotkeyImageCount = (images ?? []).filter((image) =>
        hotkeyImageSet.has(image),
      ).length;

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
      let streamedText = '';
      const settleReply = (reply: StoredReply) => {
        if (gatewaySessionId) {
          settleStoredReply(gatewaySessionId, requestId, reply, displayText);
        }
      };
      activeChatRequests.add(requestId);
      try {
        // A plain chat can be opened without creating a proactive session. Sync
        // the persisted profile on every turn so the tutor never falls back to
        // its default scenario or recommends tools the user did not select.
        const { scenario, aiTools } = readProfile();
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
        const turnTiming = new TutorTurnTiming();
        const onEvent = (streamEvent: TutorStreamEvent) => {
          if (streamEvent.type === 'text_delta') {
            const delta = String(streamEvent.text ?? '');
            turnTiming.recordTextDelta(delta);
            streamedText += delta;
          }
          if (streamEvent.type === 'done') {
            settleReply({
              text: String(streamEvent.guidance ?? streamedText),
              tutorMetrics: streamEvent.llm_metrics as
                | LLMCallMetrics
                | undefined,
              observerMetrics: streamEvent.observer_metrics as
                | LLMCallMetrics
                | undefined,
            });
          }
          if (streamEvent.type === 'error') {
            settleReply({
              text: String(
                streamEvent.error ?? 'The tutor could not generate a response.',
              ),
              isError: true,
            });
          }
          if (streamEvent.type === 'done' && gatewaySessionId) {
            const metrics = streamEvent.llm_metrics as
              | LLMCallMetrics
              | undefined;
            const model =
              metrics?.model || process.env.TUTOR_MODEL?.trim() || undefined;
            gatewayClient?.addMessage(
              gatewaySessionId,
              'coco',
              String(streamEvent.guidance ?? streamedText),
              turnTiming.complete(model),
              {
                messageKind:
                  requestKind === 'practice_suggestions'
                    ? 'practice_suggestion'
                    : 'user_response',
                fourDDimension: streamEvent.four_d_dimension,
                teachingDepth: streamEvent.teaching_depth,
                interventionSource: 'user',
              },
            );
          }
          sendChatStreamEvent(ipcEvent.sender, {
            requestId,
            ...streamEvent,
            ...(streamEvent.type === 'done'
              ? { observerMetrics: streamEvent.observer_metrics ?? null }
              : {}),
          });
        };
        if (pendingChatRequest?.stopped) {
          onEvent({ type: 'done', guidance: 'Stopped.', stopped: true });
        } else {
          await piHarness.run({
            requestId,
            sessionId: currentSessionId ?? randomUUID(),
            directory: agentDirectory(),
            tutorUrl: tutor,
            token: piBridgeToken,
            text: contextualizedUserText,
            images: images ?? [],
            emit: onEvent,
          });
        }
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
            : err instanceof Error
              ? err.message
              : 'Coco could not complete this request.';
        settleReply({ text: error, isError: true });
        sendChatStreamEvent(ipcEvent.sender, {
          requestId,
          type: 'error',
          error,
        });
        return { error };
      } finally {
        activeChatRequests.delete(requestId);
      }
    },
  ),
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

ipcMain.removeHandler('send-audio-message');
ipcMain.handle(
  'send-audio-message',
  withTutorTurn(
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
      if (!tutoringAllowed)
        return { error: 'AI tutoring is disabled for this account.' };
      await resumeReopenedConversation();
      if (!isSessionActive) {
        // A pre-session invite may already be visible from the last sensing tick.
        // Voice input is itself an explicit session start, so remove that stale UI.
        notificationWindow?.destroy();
        await createProactiveTutorSession(
          '[Voice message]',
          120,
          'user_message',
          undefined,
          {
            // Reuse the draft already displayed by the wake-word/chat flow so
            // activating the session does not clear the visible conversation.
            sessionId: currentSessionId ?? undefined,
            openChat: false,
          },
        );
      }
      const gatewaySessionId = currentSessionId;
      let storedTranscription = false;
      const tutorPort = process.env.TUTOR_PORT || '8081';
      const turnTiming = new TutorTurnTiming();
      let streamedText = '';
      const settleReply = (reply: StoredReply) => {
        if (gatewaySessionId) {
          settleStoredReply(gatewaySessionId, requestId, reply);
        }
      };
      activeChatRequests.add(requestId);
      try {
        const onEvent = (streamEvent: TutorStreamEvent) => {
          if (
            streamEvent.type === 'transcription' &&
            gatewaySessionId &&
            !storedTranscription
          ) {
            const transcription = String(streamEvent.text ?? '').trim();
            if (transcription) {
              storedTranscription = true;
              gatewayClient?.addMessage(
                gatewaySessionId,
                'user',
                transcription,
                undefined,
                { messageKind: 'voice_input' },
              );
            }
          }
          if (streamEvent.type === 'text_delta') {
            const delta = String(streamEvent.text ?? '');
            turnTiming.recordTextDelta(delta);
            streamedText += delta;
          }
          if (streamEvent.type === 'done') {
            settleReply({
              text: String(streamEvent.guidance ?? streamedText),
              tutorMetrics: streamEvent.llm_metrics as
                | LLMCallMetrics
                | undefined,
              observerMetrics: streamEvent.observer_metrics as
                | LLMCallMetrics
                | undefined,
            });
          }
          if (streamEvent.type === 'error') {
            settleReply({
              text: String(
                streamEvent.error ?? 'The tutor could not generate a response.',
              ),
              isError: true,
            });
          }
          if (streamEvent.type === 'done' && gatewaySessionId) {
            const metrics = streamEvent.llm_metrics as
              | LLMCallMetrics
              | undefined;
            const model =
              metrics?.model || process.env.TUTOR_MODEL?.trim() || undefined;
            gatewayClient?.addMessage(
              gatewaySessionId,
              'coco',
              String(streamEvent.guidance ?? streamedText),
              turnTiming.complete(model),
              {
                messageKind: 'voice_response',
                fourDDimension: streamEvent.four_d_dimension,
                teachingDepth: streamEvent.teaching_depth,
                interventionSource: 'user',
              },
            );
          }
          sendChatStreamEvent(ipcEvent.sender, {
            requestId,
            ...streamEvent,
          });
        };
        if (pendingChatRequest?.stopped) {
          onEvent({ type: 'done', guidance: 'Stopped.', stopped: true });
        } else {
          await piHarness.run({
            requestId,
            sessionId: currentSessionId ?? randomUUID(),
            directory: agentDirectory(),
            tutorUrl: `http://127.0.0.1:${tutorPort}`,
            token: piBridgeToken,
            text: '',
            images: [],
            audioData,
            emit: onEvent,
          });
        }
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
        settleReply({ text: error, isError: true });
        sendChatStreamEvent(ipcEvent.sender, {
          requestId,
          type: 'error',
          error,
        });
        return { error };
      } finally {
        activeChatRequests.delete(requestId);
      }
    },
  ),
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
  const suggestion = payload?.suggestion as InstantSuggestion | undefined;
  if (
    suggestion?.fourDDimension &&
    currentSessionId &&
    !loggedProactiveSuggestions.has(observationId)
  ) {
    loggedProactiveSuggestions.add(observationId);
    gatewayClient?.addMessage(
      currentSessionId,
      'coco',
      suggestion.copyText,
      undefined,
      {
        messageKind: 'proactive_intervention',
        fourDDimension: suggestion.fourDDimension,
        triggerType: suggestion.triggerType,
        teachingDepth: suggestion.teachingDepth,
        interventionSource: suggestion.interventionSource,
        observationId,
      },
    );
    const tutorPort = process.env.TUTOR_PORT || '8081';
    axios
      .post(
        `http://127.0.0.1:${tutorPort}/context/competency/coached`,
        { four_d_dimension: suggestion.fourDDimension },
        { timeout: 8000 },
      )
      .catch((error) => {
        log.warn(
          `[Curriculum] Failed to record ${suggestion.fourDDimension}: ${(error as Error).message}`,
        );
      });
  }
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
function updateAvatarVisibilitySetting(hideAvatar: unknown): {
  success: boolean;
  error?: string;
} {
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
    chatWindow?.webContents.send('avatar-visibility-changed', { hideAvatar });
    return { success: true };
  } catch (err) {
    log.error('[Settings] Failed to update avatar visibility:', err);
    return { success: false, error: String(err) };
  }
}

ipcMain.removeHandler('update-avatar-visibility');
ipcMain.handle(
  'update-avatar-visibility',
  (_event, { hideAvatar }: { hideAvatar?: boolean } = {}) =>
    updateAvatarVisibilitySetting(hideAvatar),
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
    const nextScenario = allowedScenario(scenario);
    // 1. Persist into the profile (merged with existing fields). Models are
    // configured via .env (TUTOR_MODEL / OBSERVER_MODEL), not here.
    try {
      let profile: Record<string, unknown> = {};
      try {
        profile = JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
      } catch {
        /* no existing profile — start fresh */
      }
      profile.tutorScenario = nextScenario;
      if (nextScenario !== 'custom') profile.customSystemPrompt = '';
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
        { scenario: nextScenario },
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
            struggle_detection_seconds: sessionStruggleSeconds,
            scenario: nextScenario,
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

// Legacy renderer hook. Once authenticated, the verified participant identity
// cannot be replaced by a renderer-provided value.
ipcMain.handle('set-user-id', async (event, userId) => {
  if (!userId || typeof userId !== 'string') {
    log.error('Invalid userId provided to set-user-id');
    return { success: false, error: 'Invalid userId' };
  }
  if (isAuthenticated && userId !== currentUserId) {
    log.warn('[User] rejected an attempt to replace the authenticated userId');
    return {
      success: false,
      error: 'Authenticated username cannot change.',
    };
  }
  currentUserId = userId;
  gatewayClient?.setUserId(userId);
  log.info(`[User] local userId set to ${userId}`);
  return { success: true };
});

interface DesktopAuthCredentials {
  participantId?: string;
  email?: string;
  password?: string;
  keepSignedIn?: boolean;
}

const configureParticipantRouterCredential = async (): Promise<void> => {
  setTutoringAllowed(true);
  studyAccessStatus = 'allowed';
  if (!gatewayClient || !process.env.LLM_ROUTER_URL?.trim()) return;
  const credential = await gatewayClient.issueRouterCredential();
  process.env.LLM_ROUTER_API_KEY = credential.token;
  ensureRouterManagedModels();
};

function applyEffectiveStudyAccess(): void {
  setTutoringAllowed(true);
  studyAccessStatus = 'allowed';
}

async function stopTutoringForAccess(): Promise<void> {
  if (pendingChatRequest) pendingChatRequest.stopped = true;
  await piHarness.abort();
  delete process.env.LLM_ROUTER_API_KEY;
  notificationWindow?.destroy();
  sessionRecapWindow?.destroy();
  sessionSetupWindow?.destroy();
  suggestionCache.clear();
  stopObservationStream();
  if (isSessionActive) endCurrentSession();
  await Promise.all([
    serviceManager.stopService('tutor-server'),
    serviceManager.stopService('sensing-server'),
  ]);
  observerStarted = false;
  syncWakeWordService();
}

async function refreshTutoringAccess() {
  applyEffectiveStudyAccess();
}

const authenticate = async (
  mode: 'signin' | 'signup',
  credentials: DesktopAuthCredentials,
) => {
  if (!gatewayClient) {
    return {
      success: false,
      error: 'The Coco backend is not configured or is unavailable.',
    };
  }
  if (
    typeof credentials?.participantId !== 'string' ||
    typeof credentials?.password !== 'string' ||
    (mode === 'signup' && typeof credentials?.email !== 'string')
  ) {
    return {
      success: false,
      error:
        mode === 'signup'
          ? 'Username, email, and password are required.'
          : 'Username and password are required.',
    };
  }
  try {
    const request = {
      participantId: credentials.participantId,
      ...(mode === 'signup' ? { email: credentials.email?.trim() } : {}),
      password: credentials.password,
      keepSignedIn: credentials.keepSignedIn !== false,
    };
    const session =
      mode === 'signup'
        ? await gatewayClient.signUp(request)
        : await gatewayClient.signIn(request);
    currentUserId = session.participantId;
    isAuthenticated = true;
    currentStudyRole = null;
    serverPreAssessmentsComplete = false;
    adminStudentMode = false;
    await configureParticipantRouterCredential();
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
    currentUserId = null;
    isAuthenticated = false;
    currentStudyRole = null;
    serverPreAssessmentsComplete = false;
    adminStudentMode = false;
    studyAccessStatus = 'unavailable';
    if (pendingChatRequest) pendingChatRequest.stopped = true;
    void piHarness.abort();
    setTutoringAllowed(false);
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

ipcMain.removeAllListeners('authentication-ui-complete');
ipcMain.on('authentication-ui-complete', () => {
  if (!isAuthenticated || !pendingAuthLaunch) return;
  const launch = pendingAuthLaunch;
  pendingAuthLaunch = null;
  authWindow?.destroy();
  if (studyAccessStatus === 'preassessment') {
    applyAvatarVisibility(readHideAvatarSetting());
    openPersonalization();
    createTray();
    return;
  }
  if (launch === 'signup') {
    // Every newly created account sees the full onboarding, even when this
    // computer has an older local profile from a previous installation.
    createOnboardingWindow();
    createTray();
    return;
  }
  const canStartConfiguredModels = Boolean(
    readModelConfiguration() ||
      (process.env.TUTOR_MODEL?.trim() && process.env.OBSERVER_MODEL?.trim()),
  );
  if (isOnboardingComplete() && canStartConfiguredModels) {
    hideAvatarMode = readHideAvatarSetting();
    startObserver();
  }
  createWindow().catch((error) => {
    log.warn(`[Auth] Could not launch Coco after sign in: ${String(error)}`);
  });
});

const createWindow = async () => {
  if (!isAuthenticated) {
    createAuthWindow();
    createTray();
    return;
  }
  if (isDebug) {
    await installExtensions();
  }

  if (!tutoringAllowed) {
    applyAvatarVisibility(readHideAvatarSetting());
    openPersonalization();
    return;
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
  revealCoco();
});

app.on('will-quit', () => {
  void piHarness.dispose();
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
    category: 'system',
  });
};

let systemPermissionDialogOpen = false;
const showSystemPermissionWarning = async (
  preferredTarget?: SystemPermissionSettingsTarget,
): Promise<void> => {
  if (systemPermissionDialogOpen) return;
  if (process.platform !== 'darwin') {
    return;
  }
  const warning = readSystemPermissionWarning();
  if (!warning) {
    return;
  }

  systemPermissionDialogOpen = true;
  try {
    log.warn(`[Permissions] ${warning.detail}`);
    const target =
      preferredTarget && warning.settingsTargets.includes(preferredTarget)
        ? preferredTarget
        : warning.settingsTargets[0];
    const label = systemPermissionButtonLabel(target).replace(/^Open /, '');
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Coco permissions required',
      message: `Allow ${label}`,
      detail: `${systemPermissionExplanation(target)}\n\nOpen System Settings and enable ${label} for ${app.isPackaged ? 'Coco' : 'Electron (development app)'}. Then quit and reopen Coco so macOS can apply the change.`,
      buttons: [systemPermissionButtonLabel(target)],
      defaultId: 0,
      noLink: true,
    });
    try {
      await openSystemPermissionSettings(target, {
        screenStatus: () => systemPreferences.getMediaAccessStatus('screen'),
        // A minimal thumbnail still exercises the capture permission path.
        // Results are discarded, never saved or sent to a model/server.
        requestScreenAccess: () =>
          desktopCapturer
            .getSources({
              types: ['screen'],
              thumbnailSize: { width: 1, height: 1 },
              fetchWindowIcons: false,
            })
            .then(() => undefined),
        // Explicitly target Apple's settings app rather than a registered URL
        // handler, and wait for launch errors so we can show the fallback.
        openExternal: (url) =>
          new Promise<void>((resolve, reject) => {
            execFile(
              '/usr/bin/open',
              ['-b', 'com.apple.systempreferences', url],
              { timeout: 5000 },
              (error) => {
                if (error) reject(error);
                else resolve();
              },
            );
          }),
        warn: (message) => log.warn(`[Permissions] ${message}`),
      });
    } catch (error) {
      log.warn(
        `[Permissions] Could not open System Settings: ${String(error)}`,
      );
      dialog.showErrorBox(
        'Open System Settings manually',
        'Open System Settings → Privacy & Security and select the requested permission. For Screen Recording, use the + button to add Coco from Applications if it is missing. Quit and reopen Coco after enabling access.',
      );
    }
  } finally {
    systemPermissionDialogOpen = false;
  }
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

const ensureRouterManagedModels = (): void => {
  if (!isLlmRouterConfigured()) return;
  try {
    const current = readModelConfiguration();
    const normalized = normalizeRouterManagedModelConfiguration(current);
    if (
      JSON.stringify(current) === JSON.stringify({ version: 1, ...normalized })
    ) {
      return;
    }
    saveModelConfiguration(normalized);
    log.info(
      '[Models] Applied Router-managed defaults: tutor=gemini/gemini-3-flash-preview observer=gemini/gemini-2.5-pro',
    );
  } catch (error) {
    log.error(`[Models] Could not apply Router-managed defaults: ${error}`);
  }
};

// Starts the sensing services and observation stream. Called once onboarding
// is complete (or immediately on subsequent launches where it's already done),
// and again from update-settings the moment the user first saves their models.
const startObserver = () => {
  if (!tutoringAllowed) return;
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
    const { userName, scenario } = readProfile();
    // Pre-session Observer invitations use the selected scenario, so sensing
    // must start with it instead of defaulting to everyday support. The Judge
    // itself starts only after the user accepts and a session is configured.
    serviceManager.configureServiceArg('sensing-server', 'scenario', scenario);
    const runtime = resolveModelRuntime();
    if (runtime) {
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
        log.error('[Personalization]', error);
      },

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
                `[Evening] Could not wake Coco after personalization: ${JSON.stringify(result)}`,
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

  // Unlike the public CoCo evening scheduler, this transition is driven by an
  // actual observation. That makes the learning review appear on the next day
  // the participant uses the computer, even if CoCo stayed open overnight.
  nextDaySummaryScheduler = new NextDaySummaryScheduler({
    statePath: path.join(
      app.getPath('userData'),
      'next-learning-review-state.json',
    ),
    onFirstUse: async ({ startTs: todayStartTs }) => {
      if (!tutoringAllowed || postAssessmentActive) return false;
      // Do not replace something time-sensitive. Returning false leaves the
      // date unhandled, so the next observation retries the summary.
      if (notificationWindow && !notificationWindow.isDestroyed()) {
        return false;
      }

      if (!currentUserId) return true;
      const recaps = readLatestUnreviewedLearningDay(
        app.getPath('userData'),
        currentUserId,
        todayStartTs,
      );
      if (recaps.length === 0) return true;
      const tutorPort = process.env.TUTOR_PORT || '8081';
      const response = await axios.post(
        `http://127.0.0.1:${tutorPort}/daily-learning-review`,
        {
          recaps: recaps.map((recap) => ({
            summary_title: recap.summaryTitle,
            bullets: recap.bullets,
          })),
        },
        { timeout: 45_000 },
      );
      const review = response.data as {
        summary_title?: unknown;
        takeaways?: unknown;
      };
      if (
        typeof review.summary_title !== 'string' ||
        !Array.isArray(review.takeaways) ||
        review.takeaways.length !== 3 ||
        !review.takeaways.every(
          (takeaway): takeaway is string =>
            typeof takeaway === 'string' && Boolean(takeaway.trim()),
        )
      ) {
        throw new Error('Tutor returned an invalid daily learning review.');
      }
      const latestRecap = recaps[recaps.length - 1];
      const summaryDate = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
      }).format(new Date(latestRecap.generatedAt * 1000));
      // Generation can take several seconds. Preserve any notification that
      // appeared while the daily review was being synthesized and retry later.
      if (notificationWindow && !notificationWindow.isDestroyed()) {
        return false;
      }
      showNotification({
        message: [
          `**Review from ${summaryDate}**`,
          review.summary_title.trim(),
          ...review.takeaways.map((takeaway) => `- ${takeaway.trim()}`),
        ].join('\n'),
        actionLabel: 'Open Coco',
        notifType: 'daily-summary',
      });
      markLearningRecapsReviewedThrough(
        app.getPath('userData'),
        currentUserId,
        latestRecap.generatedAt,
        Date.now() / 1000,
      );
      return true;
    },
  });

  // Subscribe to the sensing server's live observation feed and forward
  // each event to the avatar window. The SSE client retries with backoff,
  // so it's safe to start before the sensing server is fully up.
  const sensingPort = process.env.SENSING_PORT || '8080';
  startObservationStream({
    url: `http://127.0.0.1:${sensingPort}/observations/stream`,
    onEvent: (event) => {
      const receivedAt = Date.now();
      if (event.observation) personalizationScheduler?.noteObservation();
      if (!tutoringAllowed) return;
      if (observationSleepGuard.shouldSuppress(event.ts)) {
        if (event.observation) {
          log.info(
            `[Power] Dropped suppressed observation status=${event.status ?? '(none)'}`,
          );
        }
        return;
      }

      const status = event.status;
      if (postAssessmentActive) {
        // Preserve semantic activity for the automatic assessment report, but
        // do not surface observations, precompute help, or open notifications.
        if (status && event.observation) {
          appendActivity({
            ts: event.ts ?? Math.floor(Date.now() / 1000),
            status: status as ObservationStatus,
            observation: cleanObservation(event.observation),
            observation_id: event.observation_id,
            llm_metrics: event.llm_metrics,
          });
        }
        return;
      }
      const { scenario } = readProfile();
      const instantSuggestionEligible = shouldOfferInstantSuggestion(
        scenario,
        isSessionActive,
        event,
      );
      // A suggestion arriving while a tutor reply is on its way would land on
      // top of that reply, so it is dropped rather than shown.
      const suggestionDropped =
        instantSuggestionEligible && (interactions.movedOnSince(receivedAt) || (scenario !== 'ai_upskilling' && isChatPanelVisible()));
      if (suggestionDropped) {
        log.info(
          '[Interaction] Dropped proactive suggestion: a tutor reply is in progress.',
        );
      }
      const offerSuggestion = instantSuggestionEligible && !suggestionDropped && !proactiveSuggestionOpen;
      const personalizedSupport = scenario !== 'ai_upskilling' && Boolean(status && PRECOMPUTE_STATUSES.has(status));
      const surfaceObservation = shouldSurfaceObservation() && !personalizedSupport;

      // Tier-2 friction events from the struggle/pause path arrive without an
      // observation_id, but the precompute cache and the renderer bubble must
      // agree on a key. Since the SAME event object is forwarded to the
      // renderer below, stamp a synthetic id here so both sides line up.
      if (status && PRECOMPUTE_STATUSES.has(status) && !event.observation_id) {
        syntheticObsSeq += 1;
        event.observation_id = `synthetic-${Date.now()}-${syntheticObsSeq}`;
      }

      // Match the monorepo's lightweight feedback: every observation status is
      // forwarded to the avatar (including Stuck / AI could help). The separate
      // instantSuggestionEligible gate below ensures only Judge-approved events
      // generate a detailed proactive suggestion in AI Upskilling.
      if (
        surfaceObservation &&
        !suggestionDropped &&
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
          observation: cleanObservation(event.observation),
          observation_id: event.observation_id,
          need_support: event.need_support,
          proactive_allowed: event.proactive_allowed,
          proactive_support: offerSuggestion ? { engaged: false } : undefined,
          llm_metrics: event.llm_metrics,
        });
      }

      const taskLabel = event.task_label;

      // ── Eagerly precompute an instant suggestion for Tier-2 bubbles ───
      // AI Upskilling suggestions are generated only for Judge-approved
      // interventions inside an active session. Other modes retain their
      // existing pull-based observer suggestions.
      if (offerSuggestion) {
        const suggestionPromise = precomputeSuggestion(event);
        if (personalizedSupport) {
          latestHiddenSuggestionObservationId = event.observation_id;
          void suggestionPromise?.then((value) => {
            if (!value || hideAvatarMode || isChatPanelVisible() || proactiveSuggestionOpen ||
                isCocoSleeping() || systemSuspended ||
                latestHiddenSuggestionObservationId !== event.observation_id ||
                interactions.movedOnSince(receivedAt)) return;
            avatarWindow?.webContents.send('observation-update', {
              ...event, suggestion_title: value.title,
            });
          });
        }
        if (hideAvatarMode && event.observation) {
          const rawObservation = cleanObservation(event.observation);
          latestHiddenSuggestionObservationId = event.observation_id;
          void suggestionPromise?.then((value) => {
            // Hidden-avatar notifications preview the generated suggestion,
            // rather than the observer diagnosis that led to it.
            if (
              !value ||
              isCocoSleeping() || systemSuspended || proactiveSuggestionOpen ||
              (personalizedSupport && isChatPanelVisible()) ||
              !hideAvatarMode ||
              !shouldOfferInstantSuggestion(
                readProfile().scenario,
                isSessionActive,
                event,
              ) ||
              latestHiddenSuggestionObservationId !== event.observation_id
            ) {
              return;
            }
            // Generation takes seconds; if the user messaged the tutor or a
            // reply finished meanwhile, the tutor has the floor.
            if (interactions.movedOnSince(receivedAt)) {
              log.info(
                '[Interaction] Dropped proactive suggestion: the conversation moved on while it was generated.',
              );
              return;
            }
            const suggestion: InstantSuggestion =
              value.kind === 'delegate'
                ? {
                    ...value,
                    availableTools: buildAvailableTools(value.targetTool),
                  }
                : value;
            const chatSuggestion = toChatSuggestion(
              suggestion,
              event.observation_id,
            );
            let surface: 'chat' | 'notification';
            if (isChatPanelVisible()) {
              // The user is already in the chat, so Coco says it there.
              deliverSuggestionToChat(chatSuggestion, false);
              surface = 'chat';
            } else {
              const shown = showNotification({
                message: suggestion.title,
                actionLabel: 'Reveal full suggestion',
                notifType: 'proactive-suggestion',
                observationId: event.observation_id,
                status,
                rawObservation,
                suggestion,
                scenario: readProfile().scenario,
              });
              if (!shown || !notificationWindow) return;
              suggestionNotification = {
                window: notificationWindow,
                observationId: event.observation_id,
              };
              // A folded copy keeps it findable after the pop-up closes.
              deliverSuggestionToChat(chatSuggestion, true);
              surface = 'notification';
            }
            interactions.note('suggestion_shown');
            recordSuggestionWithTutor(chatSuggestion, event.trigger_type);
            const sensingPort = process.env.SENSING_PORT || '8080';
            axios
              .post(
                `http://127.0.0.1:${sensingPort}/feedback`,
                {
                  kind: 'shown',
                  surface,
                  observation_id: event.observation_id ?? null,
                  status,
                },
                { timeout: 3000 },
              )
              .catch((err) => {
                log.warn(
                  `[Feedback] failed to post: ${(err as Error).message}`,
                );
              });
          });
        }
      }

      // ── Pre-session: suggest starting a tutor session ─────────────────
      // The sensing-side Judge owns the invite decision. Keep the original
      // five-minute UI cooldown so repeated Judge ticks cannot make the session
      // invitation itself feel like a stream of disconnected suggestions.
      if (!isSessionActive && status === 'task_suggested' && taskLabel) {
        const now = Date.now();
        if (now - lastTaskSuggestionMs >= TASK_SUGGESTION_COOLDOWN_MS) {
          lastTaskSuggestionMs = now;
          pendingTaskLabel = taskLabel;
          const message = `I see you're ${taskLabel}. Want me to guide you with AI tools?`;
          showNotification({
            message,
            actionLabel: 'Yes, start session',
            cancelLabel: 'Not now',
            notifType: 'session-start-prompt',
          });
        }
      }

      // ── In-session: detect task completion ───────────────────────────
      if (isSessionActive && status === 'task_complete') {
        showNotification({
          message:
            'Looks like your task is done. Want to wrap up this session?',
          actionLabel: 'Yes, end session',
          cancelLabel: 'Keep going',
          notifType: 'session-end-prompt',
        });
      }

      // This event is the first concrete evidence of use today. The scheduler
      // persists the handled date, so all later observations are no-ops.
      void nextDaySummaryScheduler?.checkNow();
    },
  });
};

app
  .whenReady()
  .then(async () => {
    desktopAppUpdater.start();
    installDockUpdateMenu(desktopAppUpdater);
    await configureLocalServicePorts();
    initializeWakeWordService();
    powerMonitor.on('suspend', () => {
      log.info('[Power] System suspended; clearing proactive UI and cache.');
      systemSuspended = true;
      personalizationScheduler?.stop();
      syncWakeWordService();
      observationSleepGuard.suspend();
      latestHiddenSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('system-suspend');
      }
      chatWindow?.webContents.send('system-suspend');
    });

    powerMonitor.on('resume', () => {
      log.info('[Power] System resumed; suppressing observations briefly.');
      systemSuspended = false;
      personalizationScheduler?.start();
      syncWakeWordService();
      observationSleepGuard.resume();
      latestHiddenSuggestionObservationId = undefined;
      suggestionCache.clear();
      notificationHovered = false;
      notificationWindow?.destroy();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        // Send this again in case the renderer was frozen before handling the
        // suspend event.
        avatarWindow.webContents.send('system-suspend');
      }
    });

    // Ensure default workspace directory exists
    ensureDefaultWorkspaceExists();
    ensureRouterManagedModels();

    // Gateway delivery is opt-in: without a URL this returns null
    // and Coco remains fully local, matching the upstream privacy default.
    gatewayClient = CocoGatewayClient.fromEnvironment(
      log,
      app.isPackaged ? PACKAGED_GATEWAY_URL : '',
    );

    const storedAuth = readAuthSession(app.getPath('userData'));
    if (gatewayClient && storedAuth) {
      try {
        const restored = await gatewayClient.restoreAuthSession(
          storedAuth.token,
        );
        currentUserId = restored.participantId;
        isAuthenticated = true;
        currentStudyRole = null;
        serverPreAssessmentsComplete = false;
        adminStudentMode = false;
        await configureParticipantRouterCredential();
        log.info(`[Auth] restored session for ${restored.participantId}`);
      } catch (error) {
        clearAuthSession(app.getPath('userData'));
        currentUserId = null;
        isAuthenticated = false;
        currentStudyRole = null;
        serverPreAssessmentsComplete = false;
        adminStudentMode = false;
        log.warn(
          `[Auth] saved session could not be restored: ${String(error)}`,
        );
      }
    }

    // Only start the observer if onboarding is already done. If not, it will
    // be started by the 'onboarding-complete' IPC handler after the user
    // finishes or skips onboarding.
    const canStartConfiguredModels = Boolean(
      readModelConfiguration() ||
        (process.env.TUTOR_MODEL?.trim() && process.env.OBSERVER_MODEL?.trim()),
    );
    if (isAuthenticated && isOnboardingComplete() && canStartConfiguredModels) {
      hideAvatarMode = readHideAvatarSetting();
      startObserver();
    }

    createWindow();
    const studyPolicyTimer = setInterval(() => {
      void refreshTutoringAccess();
    }, 30000);
    studyPolicyTimer.unref();
    createWakeWordCaptureWindow();
    // Keep chat state alive while its panel is closed.
    createChatWindow();

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
      if (!areRequiredPreAssessmentsComplete()) {
        showPreAssessmentLockedMessage();
        return;
      }
      // Open the chat panel immediately so the preview has somewhere to land
      // (and the keypress feels responsive). If it was closed, this creates a
      // fresh renderer whose readiness handshake drives the flush below.
      showChatPanel();

      const sensingPort = process.env.SENSING_PORT || '8080';
      const req = require('http').request(
        {
          hostname: '127.0.0.1',
          port: sensingPort,
          path: '/hotkey/capture',
          method: 'POST',
        },
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
        },
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
      // A Dock click or reopening the running app must always surface Coco,
      // even when the chat panel is merely hidden and the menu bar icon isn't
      // visible.
      revealCoco();
    });
  })
  .catch(console.log);

app.on('before-quit', (event) => {
  personalizationScheduler?.stop();
  eveningPersonalizationScheduler?.stop();
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  log.info('App quitting: waiting up to 10s for services to stop...');
  desktopAppUpdater.stop();
  stopObservationStream();
  wakeWordService?.stop('disabled');
  const shutdownTimeoutMs = 10_000;
  const finishQuit = () => {
    if (installUpdateAfterShutdown) {
      autoUpdater.quitAndInstall(true, true);
    } else {
      app.quit();
    }
  };
  serviceManager
    .shutdown(shutdownTimeoutMs)
    .then(() => {
      log.info('Services stopped, quitting app.');
      finishQuit();
    })
    .catch((e) => {
      log.warn('Error while stopping services, quitting anyway', e);
      finishQuit();
    });
});
