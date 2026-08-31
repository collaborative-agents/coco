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
  | 'notification-revealed-state'
  | 'set-notification-expanded'
  | 'observation-update'
  | 'suppress-unrevealed-proactive-suggestion'
  | 'system-suspend'
  | 'shell-show-item-in-finder'
  | 'download-benchmark-file'
  | 'get-benchmark-files'
  | 'select-directory'
  | 'select-file-or-directory'
  | 'set-user-id'
  | 'auth-signup'
  | 'auth-signin'
  | 'auth-logout'
  | 'authentication-ui-complete'
  | 'social-list-friendships'
  | 'social-request-friend'
  | 'social-accept-friend'
  | 'social-decline-friend'
  | 'social-list-messages'
  | 'social-send-message'
  | 'social-mark-read'
  | 'social-request-knowledge'
  | 'social-list-knowledge-requests'
  | 'social-draft-knowledge-answer'
  | 'social-answer-knowledge-request'
  | 'social-decline-knowledge-request'
  | 'social-mark-knowledge-answer-read'
  | 'social-list-group-inbox'
  | 'social-accept-group-invitation'
  | 'social-decline-group-invitation'
  | 'social-list-group-members'
  | 'social-list-group-messages'
  | 'social-send-group-message'
  | 'social-mark-group-read'
  | 'social-set-group-muted'
  | 'social-leave-group'
  | 'social-mark-announcement-read'
  | 'social-report-group'
  | 'social-admin-list-groups'
  | 'social-admin-create-group'
  | 'social-admin-update-group'
  | 'social-admin-invite-group'
  | 'social-admin-revoke-invitation'
  | 'social-admin-send-group-announcement'
  | 'social-admin-send-study-announcement'
  | 'social-admin-list-group-reports'
  | 'social-admin-review-group-report'
  | 'social-inbox-updated'
  | 'social-avatar-notification'
  | 'social-avatar-notification-closed'
  | 'dismiss-social-avatar-notification'
  | 'open-social-inbox'
  | 'toggle-float-window'
  | 'float-window-state'
  | 'get-chat-content-zoom-factor'
  | 'chat-content-zoom-factor'
  | 'open-chat-settings'
  | 'open-avatar-actions-menu'
  | 'avatar-drag-start'
  | 'avatar-drag-move'
  | 'avatar-drag-end'
  | 'quit-app'
  // Proactive session flow
  | 'session-active'
  | 'show-session-setup'
  | 'session-setup-init'
  | 'proactive-session-confirmed'
  | 'proactive-session-end-confirmed'
  // Local chat (SessionChatView) — session context + user turns
  | 'session-init'
  | 'start-new-chat-session'
  | 'send-chat-message'
  | 'send-audio-message'
  | 'chat-stream-event'
  | 'get-chat-conversations'
  | 'save-chat-conversation'
  | 'resume-chat-conversation'
  // Hot-key screen capture → preview thumbnail in the chat input bar
  | 'hotkey-capture'
  // Full-display image preview shared by pending and sent chat attachments
  | 'open-image-preview'
  | 'image-preview'
  | 'image-preview-ready'
  | 'close-image-preview'
  | 'save-image-annotation'
  | 'image-annotation-saved'
  // Renderer → main: chat's hot-key listener is mounted; flush buffered captures
  | 'hotkey-capture-ready'
  // Onboarding
  | 'onboarding-complete'
  | 'model-configuration-complete'
  | 'hide-onboarding'
  | 'get-profile'
  | 'get-model-configuration'
  | 'get-service-health'
  | 'test-model-connection'
  | 'save-model-configuration'
  | 'set-chat-model'
  // Settings (post-onboarding profile edits)
  | 'save-profile'
  | 'update-settings'
  | 'update-avatar-visibility'
  | 'get-training-screenshot-retention'
  | 'get-personalization-status'
  // Long-term agent memory (view/edit)
  | 'get-memory'
  | 'save-memory'
  // Observation history
  | 'toggle-observation-history'
  | 'open-observation-history'
  | 'activity-history-visibility'
  | 'daily-memory-review-visibility'
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
  // Continue a suggestion in Coco's chat or pre-fill its composer
  | 'chat-about-suggestion'
  // Forwarded to webapp renderer to signal a help-request context
  | 'help-request'
  // Explicit user reaction (bubble engage/dismiss) → sensing /feedback
  | 'training-feedback'
  | 'get-coco-sleep-mode'
  | 'set-coco-sleep-mode'
  | 'coco-sleep-mode-changed'
  | 'get-daily-memory-draft'
  | 'approve-daily-memory-draft'
  | 'daily-memory-draft-refresh'
  | 'get-wake-word-settings'
  | 'set-wake-word-settings'
  | 'wake-word-settings-changed'
  | 'wake-word-status'
  | 'wake-word-audio-frame'
  | 'wake-word-detected'
  | 'wake-word-detection-ack'
  | 'set-wake-word-capture-paused'
  | 'wake-word-capture-paused-changed'
  | 'wake-word-capture-status'
  | 'wake-word-capture-renderer-ready'
  | 'wake-word-capture-window-ready';

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
