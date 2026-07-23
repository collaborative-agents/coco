// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import {
  contextBridge,
  ipcRenderer,
  IpcRendererEvent,
  webUtils,
} from 'electron';

export type Channels =
  | 'open-main-window'
  | 'close-main-window'
  | 'notification'
  | 'notification-hover-state'
  | 'observation-update'
  | 'shell-show-item-in-finder'
  | 'download-benchmark-file'
  | 'get-benchmark-files'
  | 'select-directory'
  | 'select-file-or-directory'
  | 'set-user-id'
  | 'toggle-float-window'
  | 'float-window-state'
  // Proactive session flow
  | 'session-active'
  | 'show-session-setup'
  | 'session-setup-init'
  | 'proactive-session-confirmed'
  | 'proactive-session-end-confirmed'
  // Local chat (SessionChatView) — session context + user turns
  | 'session-init'
  | 'send-chat-message'
  | 'chat-stream-event'
  // Hot-key screen capture → preview thumbnail in the chat input bar
  | 'hotkey-capture'
  // Renderer → main: chat's hot-key listener is mounted; flush buffered captures
  | 'hotkey-capture-ready'
  // Onboarding
  | 'onboarding-complete'
  | 'get-profile'
  // Settings (post-onboarding profile edits)
  | 'save-profile'
  | 'update-settings'
  // Long-term agent memory (view/edit)
  | 'get-memory'
  | 'save-memory'
  // Observation history
  | 'toggle-observation-history'
  | 'open-observation-history'
  | 'activity-history-visibility'
  | 'avatar-renderer-ready'
  // Activity panel hydrates persisted history from main on open
  | 'get-activity-history'
  // Persist an observation's proactive-support engagement + revealed content
  | 'activity-support-engaged'
  // Persist support content/rating independently of initial engagement
  | 'activity-support-rated'
  // Renderer asks main to resize the avatar window to fit current content
  | 'resize-avatar-window'
  // Tier 3: tutor guidance routed to bubble when webapp is hidden
  | 'tutor-notification'
  // Tier 2: user clicked "Help me with this" in the bubble
  | 'help-me-with-this'
  | 'open-notification-suggestion'
  // Instant suggestion: fetch the precomputed suggestion for an observation
  | 'get-instant-suggestion'
  // Instant suggestion: act on a revealed suggestion (copy / open tool)
  | 'suggestion-action'
  // Continue a revealed instant suggestion in Coco's chat
  | 'chat-about-suggestion'
  // Forwarded to webapp renderer to signal a help-request context
  | 'help-request'
  // Explicit user reaction (bubble engage/dismiss) → sensing /feedback
  | 'training-feedback';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    invoke(channel: Channels, ...args: unknown[]) {
      return ipcRenderer.invoke(channel, ...args);
    },
  },
  webUtils: {
    // Expose webUtils.getPathForFile to get the real file path in the renderer process
    // This is necessary because the File object in the browser/renderer does not expose the full path for security reasons
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  env: {
    get: (key: string) => process.env[key],
  },
  benchmark: {
    downloadFile: (
      apiUrl: string,
      taskId: string,
      filename: string,
      workspaceDir: string,
    ) =>
      ipcRenderer.invoke('download-benchmark-file', {
        apiUrl,
        taskId,
        filename,
        workspaceDir,
      }),
    getFileList: (apiUrl: string, taskId: string) =>
      ipcRenderer.invoke('get-benchmark-files', { apiUrl, taskId }),
  },
  auth: {
    setUserId: (userId: string) => ipcRenderer.invoke('set-user-id', userId),
  },
  dialog: {
    selectFileOrDirectory: () => ipcRenderer.invoke('select-file-or-directory'),
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
