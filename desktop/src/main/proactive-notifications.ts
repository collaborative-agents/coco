import { BrowserWindow, screen } from 'electron';
import type { IpcMain } from 'electron';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { resolveHtmlPath } from './util';
import configureFullscreenCompanionWindow from './services/fullscreen-companion-window';
import type { InstantSuggestion, ChatSeed } from './proactive-types';
interface Dependencies {
  ipc: Pick<IpcMain, 'on' | 'removeAllListeners'>;
  avatar: () => BrowserWindow | null;
  avatarHidden: () => boolean;
  preload: () => string;
  taskLabel: () => string | null;
  clearHiddenSuggestion: () => void;
  startSession: (
    label: string,
    seconds: number,
    seed?: ChatSeed,
  ) => Promise<string | null>;
  endSession: () => void;
}
export default function createProactiveNotifications(deps: Dependencies) {
  let notificationWindow: BrowserWindow | null = null;
  let notificationHovered = false;
  let proactiveSuggestionOpen = false;
  let avatarInvite: { inviteId: string; taskLabel: string } | null = null;
  let sessionSetupWindow: BrowserWindow | null = null;
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
      webPreferences: { preload: deps.preload() },
    });

    const url = `${resolveHtmlPath('index.html')}?view=session-setup`;
    sessionSetupWindow.loadURL(url);

    const window = sessionSetupWindow;
    window.on('ready-to-show', () => {
      if (window !== sessionSetupWindow || window.isDestroyed()) return;
      window.show();
      window.webContents.send('session-setup-init', { taskLabel });
    });

    window.on('closed', () => {
      if (window === sessionSetupWindow) sessionSetupWindow = null;
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
      deps.clearHiddenSuggestion();
    }
    if (
      (notificationHovered || proactiveSuggestionOpen) &&
      notificationWindow &&
      !notificationWindow.isDestroyed()
    ) {
      log.info(
        '[Notification] Keeping hovered notification; dropping replacement.',
      );
      return;
    }
    // Destroy any existing notification before showing a new one (dedup guard).
    notificationHovered = false;
    proactiveSuggestionOpen = false;
    notificationWindow?.destroy();

    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - NOTIF_WIDTH - 16;
    const y = workArea.y + 16;
    const adjustable = deps.avatarHidden();

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
      webPreferences: { preload: deps.preload() },
    });

    configureFullscreenCompanionWindow(notificationWindow);
    const url = `${resolveHtmlPath('index.html')}?view=notification`;
    notificationWindow.loadURL(url);

    const window = notificationWindow;
    window.on('ready-to-show', () => {
      if (window !== notificationWindow || window.isDestroyed()) return;
      window.show();
      window.webContents.send('notification', {
        ...payload,
        adjustable,
      });
    });

    window.on('closed', () => {
      if (window !== notificationWindow) return;
      notificationWindow = null;
      notificationHovered = false;
      proactiveSuggestionOpen = false;
    });
  };

  deps.ipc.removeAllListeners('notification');
  deps.ipc.on('notification', (_event, args) => {
    const { msg, buttonText } = args;
    showNotification({
      message: msg,
      actionLabel: buttonText,
    });
  });

  deps.ipc.removeAllListeners('notification-hover-state');
  deps.ipc.on(
    'notification-hover-state',
    (_event, { hovered }: { hovered?: boolean }) => {
      notificationHovered = hovered === true;
    },
  );

  deps.ipc.removeAllListeners('set-notification-expanded');
  deps.ipc.on(
    'set-notification-expanded',
    (_event, { expanded }: { expanded?: boolean }) => {
      if (
        !deps.avatarHidden() ||
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
        Math.min(
          current.x,
          display.workArea.x + display.workArea.width - width,
        ),
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

  // Fit the notification to its rendered content.
  deps.ipc.removeAllListeners('fit-notification-height');
  deps.ipc.on(
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
        NOTIF_EXPANDED_HEIGHT,
        workArea.y + workArea.height - current.y,
      );
      const fitted = Math.round(
        Math.max(NOTIF_HEIGHT, Math.min(height, maxHeight)),
      );
      if (fitted !== current.height) {
        notificationWindow.setBounds({ ...current, height: fitted });
      }
    },
  );

  // User clicked "Yes" in the "start a session?" notification.
  // Main shows the mini session-setup window.
  deps.ipc.on('session-invite-accepted', () => {
    notificationWindow?.destroy();
    void deps.startSession(deps.taskLabel() || 'General help session', 120);
  });

  deps.ipc.removeAllListeners('show-session-setup');
  deps.ipc.on('show-session-setup', () => {
    notificationWindow?.destroy();
    showSessionSetupWindow(deps.taskLabel());
  });

  // User confirmed the task + struggle-time in the session-setup window.
  deps.ipc.on(
    'session-invite-response',
    (_event, payload: { inviteId?: string; outcome?: string } = {}) => {
      if (!avatarInvite || payload.inviteId !== avatarInvite.inviteId) return;
      const invite = avatarInvite;
      avatarInvite = null;
      deps.avatar()?.webContents.send('session-invite-clear', invite);
      if (payload.outcome === 'accepted')
        void deps.startSession(invite.taskLabel, 120);
    },
  );
  deps.ipc.on(
    'session-invite-busy',
    (_event, payload: { inviteId?: string } = {}) => {
      if (!avatarInvite || avatarInvite.inviteId !== payload.inviteId) return;
      showNotification({
        message: `Want help with ${avatarInvite.taskLabel}?`,
        actionLabel: 'Yes, start session',
        cancelLabel: 'Not now',
        notifType: 'session-start-prompt',
      });
      avatarInvite = null;
    },
  );

  deps.ipc.removeAllListeners('proactive-session-confirmed');
  deps.ipc.on(
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
      // the auto-detected deps.taskLabel(), then a generic default.
      const problemStatement =
        taskLabel?.trim() || deps.taskLabel() || 'General help session';
      await deps.startSession(problemStatement, struggleSeconds);
    },
  );

  // User clicked "Yes" in the "task done?" notification — end the session.
  // Recap/rating were cloud-analytics features and are intentionally dropped in
  // the local build, so this just tears the session down.
  deps.ipc.removeAllListeners('proactive-session-end-confirmed');
  deps.ipc.on('proactive-session-end-confirmed', () => {
    notificationWindow?.destroy();
    deps.endSession();
  });

  deps.ipc.on('proactive-suggestion-open-state', (_event, { open } = {}) => {
    proactiveSuggestionOpen = open === true;
  });

  function clearInvite() {
    if (avatarInvite)
      deps.avatar()?.webContents.send('session-invite-clear', avatarInvite);
    avatarInvite = null;
  }
  return {
    showNotification,
    dismissNotification: () => {
      notificationHovered = false;
      notificationWindow?.destroy();
    },
    clearInvite,
    invite(taskLabel: string, rawObservation: string) {
      clearInvite();
      avatarInvite = { inviteId: randomUUID(), taskLabel };
      deps
        .avatar()
        ?.webContents.send('session-invite', {
          ...avatarInvite,
          rawObservation,
        });
    },
  };
}
