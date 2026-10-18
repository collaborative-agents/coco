import subscribeCocoSleepMode from '../services/coco-sleep-mode';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import PersonalizationCenter from './PersonalizationCenter';
export { PersonalizationStatusPanel } from './PersonalizationCenter';

import 'katex/dist/katex.min.css';
import {
  startVoiceRecorder,
  type ActiveVoiceRecorder,
  type VoiceRecorderStatus,
} from '../voice-recorder';
import type { LLMCallMetrics, TutorToolCall } from './observation-types';
import { defaultMode, normalizeSupportedModes } from '../../shared/agent-modes';
import type { AgentModeId } from '../../shared/agent-modes';
import type { AgentActivity } from '../../shared/agent-execution';
import type { ChatSuggestion } from '../../shared/chat-suggestion';
import { suggestionMessage } from './chat/MessageContent';
import { copyableMessageText, makeMessageId } from './chat/message-format';
import type {
  ChatMessage,
  SavedConversation,
  ServiceHealthView,
  SleepingServiceHealthView,
  SystemPermissionTarget,
  SystemPermissionHealth,
  WakeWordSettingsInfo,
} from './chat/types';
import { S } from './chat/styles';
import ChatHeader from './chat/ChatHeader';
import ChatTranscript from './chat/ChatTranscript';
import ChatComposer from './chat/ChatComposer';
import DesktopWorkspace from './chat/DesktopWorkspace';
import ConversationSidebar from './chat/ConversationSidebar';
import HealthSettings from './chat/HealthSettings';
import PreferencesSettings from './chat/PreferencesSettings';
import AccountSettings from './chat/AccountSettings';
import MemorySettings from './chat/MemorySettings';

export { ToolCallCard } from './chat/ToolCallCard';

export default function SessionChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingContextLabel, setPendingContextLabel] = useState<string | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<
    'idle' | 'requesting' | VoiceRecorderStatus
  >('idle');
  const [voiceError, setVoiceError] = useState('');
  const [startingNewSession, setStartingNewSession] = useState(false);
  const [checkingUnderstanding, setCheckingUnderstanding] = useState(false);
  const [understandingError, setUnderstandingError] = useState('');
  const [problem, setProblem] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [activePage, setActivePage] = useState<'chat' | 'personalization' | 'settings'>(
    'chat',
  );
  const changeExpanded = (value: boolean) => {
    setExpanded(value);
    window.electron?.ipcRenderer.sendMessage('toggle-float-window', {
      expanded: value,
    });
  };
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'float-window-state',
      (payload) => {
        setExpanded(!(payload as { isFloat: boolean }).isFloat);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);
  const [contentZoomFactor, setContentZoomFactor] = useState(1);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [reviewing, setReviewing] = useState<SavedConversation | null>(null);
  const [profile, setProfile] = useState<{
    scenario: string;
    aiTools: string[];
    hideAvatar: boolean;
  }>({
    scenario: 'everyday_support',
    aiTools: [],
    hideAvatar: false,
  });
  const [currentTutorModelId, setCurrentTutorModelId] = useState('');
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthView | null>(
    null,
  );
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [systemPermissionHealth, setSystemPermissionHealth] =
    useState<SystemPermissionHealth>({ missing: [] });
  const [permissionOpening, setPermissionOpening] =
    useState<SystemPermissionTarget | null>(null);
  const [permissionError, setPermissionError] = useState('');
  const [cocoSleeping, setCocoSleeping] = useState(false);
  const [cocoSleepModeKnown, setCocoSleepModeKnown] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeWordStatus, setWakeWordStatus] =
    useState<WakeWordSettingsInfo['status']>('disabled');
  const [wakeWordDetail, setWakeWordDetail] = useState('');
  const [wakeWordCaptureError, setWakeWordCaptureError] = useState('');
  const [wakeWordSaving, setWakeWordSaving] = useState(false);
  const [editHideAvatar, setEditHideAvatar] = useState(false);
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'avatar-visibility-changed',
      (value) => {
        const next = value as { hideAvatar?: boolean } | undefined;
        if (typeof next?.hideAvatar === 'boolean')
          setEditHideAvatar(next.hideAvatar);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarSaveError, setAvatarSaveError] = useState('');
  // Long-term agent memory (loaded from / saved to the tutor server).
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryLoaded, setMemoryLoaded] = useState('');
  const [memoryFlash, setMemoryFlash] = useState(false);
  // Current thumbs vote per tutor message, keyed by message id. Users may
  // replace it by choosing the opposite rating.
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down'>>({});
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingHotkeyImagesRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(null);
  const pendingContextRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const problemRef = useRef('');
  const cocoSleepingRef = useRef(false);
  const sleepModeRevisionRef = useRef(0);
  const voiceRecorderRef = useRef<ActiveVoiceRecorder | null>(null);
  const handleVoiceClickRef = useRef<(fromWakeWord?: boolean) => Promise<void>>(
    async () => {},
  );
  const wakeDetectionInProgressRef = useRef(false);

  useEffect(() => () => voiceRecorderRef.current?.cancel(), []);

  useEffect(() => {
    const applyZoomFactor = (value: unknown) => {
      const factor = Number(value);
      if (Number.isFinite(factor) && factor > 0) setContentZoomFactor(factor);
    };
    window.electron?.ipcRenderer
      .invoke('get-chat-content-zoom-factor')
      .then(applyZoomFactor)
      .catch(() => {});
    const cleanup = window.electron?.ipcRenderer.on(
      'chat-content-zoom-factor',
      applyZoomFactor,
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const applyCocoSleepMode = useCallback((sleeping: boolean) => {
    if (cocoSleepingRef.current !== sleeping) sleepModeRevisionRef.current += 1;
    cocoSleepingRef.current = sleeping;
    setCocoSleeping(sleeping);
    setCocoSleepModeKnown(true);
    if (sleeping) {
      setServiceHealth(null);
      setHealthError('');
      setHealthLoading(false);
    }
  }, []);

  const refreshServiceHealth = useCallback(
    async (forceModelTest = false) => {
      if (cocoSleepingRef.current) return;
      const sleepRevision = sleepModeRevisionRef.current;
      setHealthLoading(true);
      setHealthError('');
      try {
        const result = (await window.electron?.ipcRenderer.invoke(
          'get-service-health',
          { forceModelTest },
        )) as ServiceHealthView | SleepingServiceHealthView | undefined;
        if (sleepRevision !== sleepModeRevisionRef.current) return;
        if (result && 'sleeping' in result && result.sleeping) {
          applyCocoSleepMode(true);
          return;
        }
        if (
          !result ||
          !('sensing' in result) ||
          !('tutor' in result) ||
          !result.sensing ||
          !result.tutor
        ) {
          throw new Error('No health response received.');
        }
        if (!cocoSleepingRef.current) setServiceHealth(result);
      } catch (error) {
        if (!cocoSleepingRef.current) {
          setHealthError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (!cocoSleepingRef.current) setHealthLoading(false);
      }
    },
    [applyCocoSleepMode],
  );

  const refreshSystemPermissions = useCallback(async () => {
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'get-system-permissions',
      )) as SystemPermissionHealth | undefined;
      if (result && Array.isArray(result.missing)) {
        setSystemPermissionHealth(result);
      }
    } catch {
      // Permission health is advisory. Leave the section hidden if macOS
      // cannot report a status instead of showing a false warning.
    }
  }, []);

  const openSystemPermission = useCallback(
    async (target: SystemPermissionTarget) => {
      setPermissionOpening(target);
      setPermissionError('');
      try {
        const result = (await window.electron?.ipcRenderer.invoke(
          'open-system-permissions',
          target,
        )) as { success?: boolean; error?: string } | undefined;
        if (!result?.success) {
          throw new Error(
            result?.error || 'Could not open macOS System Settings.',
          );
        }
        await refreshSystemPermissions();
      } catch (error) {
        setPermissionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setPermissionOpening(null);
      }
    },
    [refreshSystemPermissions],
  );

  // Keep each active conversation on disk. A short debounce avoids a write for
  // every streaming token while still preserving completed turns promptly.
  useEffect(() => {
    messagesRef.current = messages;
    problemRef.current = problem;
    if (!sessionIdRef.current || messages.length === 0) return undefined;
    const timeout = window.setTimeout(() => {
      window.electron?.ipcRenderer
        .invoke('save-chat-conversation', {
          sessionId: sessionIdRef.current,
          problem,
          messages,
        })
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [messages, problem]);

  // Rate a tutor message. Routed main → sensing /feedback → feedback.jsonl,
  // same pipeline as the bubble reactions.
  const rateMessage = (m: ChatMessage, dir: 'up' | 'down') => {
    if (!m.id || ratings[m.id] === dir) return;
    const previousRating = ratings[m.id];
    setRatings((prev) => ({ ...prev, [m.id as string]: dir }));
    const observationId = m.suggestion?.observationId;
    if (observationId) {
      // Rate the suggestion itself too, as the pop-up does, so History shows it.
      window.electron?.ipcRenderer.sendMessage('activity-support-rated', {
        observationId,
        rating: dir,
        ratedAt: Math.floor(Date.now() / 1000),
      });
    }
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
      surface: 'chat',
      ...(observationId ? { observation_id: observationId } : {}),
      message_id: m.id,
      session_id: sessionIdRef.current,
      latency_s: m.ts ? (Date.now() - m.ts) / 1000 : null,
      text: m.text,
    });
  };

  const copyMessage = async (message: ChatMessage, key: string) => {
    const text = copyableMessageText(message).trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageKey(key);
      window.setTimeout(() => {
        setCopiedMessageKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // Leave the button unchanged if the OS clipboard rejects the write.
    }
  };

  const openImagePreview = (imageDataUrl: string) => {
    window.electron?.ipcRenderer.sendMessage('open-image-preview', {
      imageDataUrl,
    });
  };

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current)
        listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, []);

  // Main relays SSE events from the tutor service. Keep one pending tutor
  // message and update it in place so text and tool activity appear in order.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'chat-stream-event',
      (data: any) => {
        const event = (data ?? {}) as {
          requestId?: string;
          type?: string;
          text?: string;
          call?: TutorToolCall;
          activity?: AgentActivity[];
          stopped?: boolean;
          guidance?: string;
          error?: string;
          observerMetrics?: LLMCallMetrics | null;
          llm_metrics?: LLMCallMetrics | null;
          tool_calls?: TutorToolCall[];
        };
        if (!event.requestId) return;
        setMessages((current) => {
          if (event.type === 'transcription') {
            const tutorIndex = current.findIndex(
              (message) => message.requestId === event.requestId,
            );
            const userIndex = tutorIndex - 1;
            if (userIndex >= 0 && current[userIndex]?.role === 'user') {
              return current.map((message, index) =>
                index === userIndex
                  ? { ...message, text: event.text?.trim() || message.text }
                  : message,
              );
            }
            return current;
          }
          return current.map((message) => {
            if (message.requestId !== event.requestId) return message;
            if (event.type === 'agent_activity') {
              return {
                ...message,
                activity: event.activity,
                text: event.text ?? message.text,
              };
            }
            if (event.type === 'text_delta') {
              return { ...message, text: message.text + (event.text ?? '') };
            }
            if (event.type === 'tool_call_started' && event.call) {
              return {
                ...message,
                toolCalls: [
                  ...(message.toolCalls ?? []).filter(
                    (call) => call.id !== event.call?.id,
                  ),
                  event.call,
                ],
              };
            }
            if (event.type === 'tool_call_completed' && event.call) {
              return {
                ...message,
                toolCalls: (message.toolCalls ?? []).some(
                  (call) => call.id === event.call?.id,
                )
                  ? (message.toolCalls ?? []).map((call) =>
                      call.id === event.call?.id
                        ? (event.call as TutorToolCall)
                        : call,
                    )
                  : [...(message.toolCalls ?? []), event.call],
              };
            }
            if (event.type === 'done') {
              return {
                ...message,
                text: event.guidance ?? message.text,
                activity: event.activity ?? message.activity,
                stopped: event.stopped,
                id: message.id ?? makeMessageId(),
                ts: Date.now(),
                observerMetrics: event.observerMetrics ?? null,
                tutorMetrics: event.llm_metrics ?? null,
                toolCalls: event.tool_calls ?? message.toolCalls ?? [],
                isStreaming: false,
              };
            }
            if (event.type === 'error') {
              return {
                ...message,
                text: event.error ?? 'The tutor could not generate a response.',
                isError: true,
                isStreaming: false,
              };
            }
            return message;
          });
        });
        if (event.type === 'done' || event.type === 'error') setSending(false);
        scrollToBottom();
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [scrollToBottom]);

  const submitTutorRequest = useCallback(
    async (
      requestId: string,
      userText: string,
      images: string[],
      displayText?: string,
      isRetry = false,
      requestKind: 'chat' | 'practice_suggestions' = 'chat',
      hotkeyImages: string[] = [],
    ) => {
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer
        .invoke('send-chat-message', {
          requestId,
          userText,
          displayText,
          isRetry,
          images,
          requestKind,
          hotkeyImages,
        })
        .catch((error: Error) => ({ error: error.message }));
      const r = res as
        | {
            streamed?: boolean;
            guidance?: string;
            error?: string;
            observerMetrics?: LLMCallMetrics | null;
            tutorMetrics?: LLMCallMetrics | null;
            toolCalls?: TutorToolCall[];
          }
        | undefined;
      // Compatibility with older main processes and a fallback if IPC fails
      // before a stream event can be delivered.
      if (!r?.streamed && (r?.guidance !== undefined || r?.error)) {
        setMessages((current) =>
          current.map((message) =>
            message.requestId === requestId
              ? {
                  ...message,
                  text: r.error ?? r.guidance ?? '',
                  isError: Boolean(r.error),
                  isStreaming: false,
                  id: r.error ? undefined : makeMessageId(),
                  ts: r.error ? undefined : Date.now(),
                  observerMetrics: r.observerMetrics ?? null,
                  tutorMetrics: r.tutorMetrics ?? null,
                  toolCalls: r.toolCalls ?? [],
                }
              : message,
          ),
        );
        setSending(false);
      }
      scrollToBottom();
    },
    [scrollToBottom],
  );

  const submitAudioRequest = useCallback(
    async (requestId: string, audioData: string) => {
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer
        .invoke('send-audio-message', {
          requestId,
          audioData,
        })
        .catch((error: Error) => ({ error: error.message }));
      const result = res as
        | {
            streamed?: boolean;
            error?: string;
          }
        | undefined;
      if (!result?.streamed && result?.error) {
        setMessages((current) =>
          current.map((message) =>
            message.requestId === requestId
              ? {
                  ...message,
                  text: result.error ?? 'The audio tutor could not respond.',
                  isError: true,
                  isStreaming: false,
                }
              : message,
          ),
        );
        setSending(false);
      }
      scrollToBottom();
    },
    [scrollToBottom],
  );

  const sendVoiceMessage = useCallback(
    async (audioData: string) => {
      const requestId = makeMessageId();
      setMessages((current) => [
        ...current,
        { role: 'user', text: '🎤 Voice message' },
        {
          role: 'tutor',
          text: '',
          requestId,
          isStreaming: true,
          retryRequestKind: 'chat',
          toolCalls: [],
        },
      ]);
      await submitAudioRequest(requestId, audioData);
    },
    [submitAudioRequest],
  );

  // Core send: append the user turn and an empty tutor turn immediately. The
  // latter is filled by chat-stream-event updates while the IPC request runs.
  const sendMessage = useCallback(
    async (
      text: string,
      images: string[],
      hotkeyImages: string[] = [],
      requestKind: 'chat' | 'practice_suggestions' = 'chat',
    ) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      const requestId = makeMessageId();
      const pendingContext = pendingContextRef.current;
      const userText = pendingContext
        ? `${pendingContext}\n\nThe user now says:\n${trimmed}`
        : trimmed;
      setMessages((m) => [
        ...m,
        { role: 'user', text: trimmed, images },
        {
          role: 'tutor',
          text: '',
          requestId,
          isStreaming: true,
          toolCalls: [],
          retryText: userText,
          retryImages: images,
          retryRequestKind: requestKind,
          retryHotkeyImages: hotkeyImages,
        },
      ]);
      pendingContextRef.current = null;
      setPendingContextLabel(null);
      await submitTutorRequest(
        requestId,
        userText,
        images,
        trimmed,
        false,
        requestKind,
        hotkeyImages,
      );
    },
    [submitTutorRequest],
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (sending || startingNewSession || message.retryText === undefined)
        return;
      const previousRequestId = message.requestId;
      const requestId = makeMessageId();
      // Saved conversations don't keep retry images; reuse the user turn's.
      const messageIndex = messagesRef.current.indexOf(message);
      const askedWith =
        messageIndex > 0 ? messagesRef.current[messageIndex - 1] : undefined;
      const images =
        message.retryImages ??
        (askedWith?.role === 'user' ? askedWith.images : undefined) ??
        [];
      const hotkeyImages = message.retryHotkeyImages ?? [];
      setMessages((current) =>
        current.map((item) =>
          item.requestId === previousRequestId
            ? {
                ...item,
                text: '',
                requestId,
                isError: false,
                isStreaming: true,
                toolCalls: [],
                activity: undefined,
                stopped: false,
              }
            : item,
        ),
      );
      await submitTutorRequest(
        requestId,
        message.retryText,
        images,
        undefined,
        true,
        message.retryRequestKind ?? 'chat',
        hotkeyImages,
      );
    },
    [sending, startingNewSession, submitTutorRequest],
  );

  // Session context from main. A new sessionId resets the conversation.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'session-init',
      (data: any) => {
        const { sessionId, problemStatement, tutorModelId } = (data ?? {}) as {
          sessionId?: string;
          problemStatement?: string;
          tutorModelId?: string;
        };
        if (tutorModelId) setCurrentTutorModelId(tutorModelId);
        if (sessionId && sessionId !== sessionIdRef.current) {
          if (sessionIdRef.current && messagesRef.current.length > 0) {
            window.electron?.ipcRenderer
              .invoke('save-chat-conversation', {
                sessionId: sessionIdRef.current,
                problem: problemRef.current,
                messages: messagesRef.current,
              })
              .catch(() => {});
          }
          sessionIdRef.current = sessionId;
          setMessages([]);
          setRatings({});
          setInput('');
          setPendingImages([]);
          pendingHotkeyImagesRef.current.clear();
          setSending(false);
          pendingContextRef.current = null;
          setPendingContextLabel(null);
          window.electron?.ipcRenderer
            .invoke('get-chat-conversations')
            .then((saved: unknown) => {
              if (sessionIdRef.current !== sessionId || !Array.isArray(saved)) {
                return;
              }
              const conversation = (saved as SavedConversation[]).find(
                (candidate) => candidate.sessionId === sessionId,
              );
              if (!conversation) return;
              const savedSuggestionIds = new Set(
                conversation.messages
                  .map((m) => m.suggestion?.observationId)
                  .filter(Boolean),
              );
              setMessages((current) =>
                current.length === 0
                  ? conversation.messages
                  : [
                      ...conversation.messages,
                      // A suggestion delivered before the restore finished may
                      // already be in the saved copy.
                      ...current.filter(
                        (m) =>
                          !m.suggestion?.observationId ||
                          !savedSuggestionIds.has(m.suggestion.observationId),
                      ),
                    ],
              );
              // A reply started before this window opened is still streaming;
              // its remaining events update the restored message in place.
              if (conversation.messages.some((m) => m.isStreaming)) {
                setSending(true);
              }
              setProblem(
                problemStatement?.trim()
                  ? problemStatement
                  : conversation.problem,
              );
            })
            .catch(() => {});
        }
        setProblem(problemStatement ?? '');
        setActivePage('chat');
        setShowSettings(false);
        setReviewing(null);
        setShowHistory(false);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // Keep chat context and the selected model in sync with the saved profile.
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return undefined;
    ipc
      .invoke('get-model-configuration')
      .then((config: any) => {
        setCurrentTutorModelId(
          (current) => current || config?.defaultTutorId || '',
        );
        return undefined;
      })
      .catch(() => {});

    Promise.all([ipc.invoke('get-profile'), ipc.invoke('get-supported-modes')])
      .then(([p, configuredModes]: any[]) => {
        const nextModes = normalizeSupportedModes(configuredModes);
        const savedScenario =
          typeof p?.tutorScenario === 'string' ? p.tutorScenario : '';
        const nextScenario = nextModes.includes(savedScenario as AgentModeId)
          ? savedScenario
          : defaultMode(nextModes);
        const next = {
          scenario: nextScenario,
          aiTools: Array.isArray(p?.aiTools) ? p.aiTools : [],
          hideAvatar: p?.hideAvatar === true,
        };
        setProfile(next);
        setEditHideAvatar(next.hideAvatar);
        return undefined;
      })
      .catch(() => {});
    return undefined;
  }, []);

  const updateAvatarVisibility = async (hideAvatar: boolean) => {
    if (avatarSaving) return;
    const previousValue = editHideAvatar;
    setEditHideAvatar(hideAvatar);
    setAvatarSaving(true);
    setAvatarSaveError('');
    try {
      const result = await window.electron?.ipcRenderer.invoke(
        'update-avatar-visibility',
        { hideAvatar },
      );
      if (!(result as { success?: boolean })?.success) {
        throw new Error(
          (result as { error?: string })?.error ||
            'Could not update desktop avatar visibility.',
        );
      }
      setProfile((current) => ({ ...current, hideAvatar }));
    } catch (error) {
      setEditHideAvatar(previousValue);
      setAvatarSaveError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setAvatarSaving(false);
    }
  };

  // Load the agent memory whenever the Settings panel is opened.
  useEffect(() => {
    if (!showSettings) return;
    void refreshSystemPermissions();
    window.electron?.ipcRenderer
      .invoke('get-memory')
      .then((r: any) => {
        const mem = String(r?.memory ?? '');
        setMemoryDraft(mem);
        setMemoryLoaded(mem);
      })
      .catch(() => {});
  }, [refreshSystemPermissions, showSettings]);

  useEffect(
    () => subscribeCocoSleepMode(applyCocoSleepMode),
    [applyCocoSleepMode],
  );

  useEffect(() => {
    if (!cocoSleepModeKnown || cocoSleeping) return undefined;
    void refreshServiceHealth();
    const interval = window.setInterval(() => {
      void refreshServiceHealth();
    }, 30000);
    return () => window.clearInterval(interval);
  }, [cocoSleepModeKnown, cocoSleeping, refreshServiceHealth]);

  useEffect(() => {
    const applySettings = (value: unknown) => {
      const settings = value as Partial<WakeWordSettingsInfo> | undefined;
      if (typeof settings?.enabled === 'boolean') {
        setWakeWordEnabled(settings.enabled);
      }
      if (settings?.status) setWakeWordStatus(settings.status);
      setWakeWordDetail(settings?.detail ?? '');
    };
    window.electron?.ipcRenderer
      .invoke('get-wake-word-settings')
      .then(applySettings)
      .catch(() => {});
    const removeSettingsListener = window.electron?.ipcRenderer.on(
      'wake-word-settings-changed',
      applySettings,
    );
    const removeStatusListener = window.electron?.ipcRenderer.on(
      'wake-word-status',
      (value: unknown) => {
        const status = value as Partial<WakeWordSettingsInfo> | undefined;
        if (status?.status) setWakeWordStatus(status.status);
        setWakeWordDetail(status?.detail ?? '');
      },
    );
    const removeDetectionListener = window.electron?.ipcRenderer.on(
      'wake-word-detected',
      (value: unknown) => {
        const detection = value as { id?: unknown } | undefined;
        if (typeof detection?.id === 'number') {
          window.electron?.ipcRenderer.sendMessage('wake-word-detection-ack', {
            id: detection.id,
          });
        }
        if (wakeDetectionInProgressRef.current) return;
        wakeDetectionInProgressRef.current = true;
        handleVoiceClickRef.current(true).finally(() => {
          wakeDetectionInProgressRef.current = false;
        });
      },
    );
    const removeCaptureStatusListener = window.electron?.ipcRenderer.on(
      'wake-word-capture-status',
      (value: unknown) => {
        const capture = value as
          | {
              state?: unknown;
              detail?: unknown;
            }
          | undefined;
        if (capture?.state === 'error') {
          setWakeWordCaptureError(
            typeof capture.detail === 'string'
              ? capture.detail
              : 'Microphone capture failed.',
          );
        } else if (capture?.state === 'active') {
          setWakeWordCaptureError('');
        }
      },
    );
    return () => {
      if (typeof removeSettingsListener === 'function')
        removeSettingsListener();
      if (typeof removeStatusListener === 'function') removeStatusListener();
      if (typeof removeDetectionListener === 'function')
        removeDetectionListener();
      if (typeof removeCaptureStatusListener === 'function') {
        removeCaptureStatusListener();
      }
    };
  }, []);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'open-chat-settings',
      () => {
        setShowHistory(false);
        setReviewing(null);
        setShowSettings(true);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  useEffect(() => {
    if (showSettings) {
      setActivePage('settings');
      setExpanded(true);
      window.electron?.ipcRenderer.sendMessage('toggle-float-window', {
        expanded: true,
      });
    }
  }, [showSettings]);
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'open-personalization-panel',
      () => {
        setShowSettings(false);
        setShowHistory(false);
        setActivePage('personalization');
        setExpanded(true);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const saveMemory = async () => {
    const res = await window.electron?.ipcRenderer.invoke('save-memory', {
      memory: memoryDraft,
    });
    if ((res as { success?: boolean })?.success) {
      setMemoryLoaded(memoryDraft);
      setMemoryFlash(true);
      setTimeout(() => setMemoryFlash(false), 1500);
    }
  };
  const memoryDirty = memoryDraft !== memoryLoaded;

  // Context from proactive support. Ordinary "Help me with this" requests are
  // sent immediately; "Ask Coco about it" stages context for the next message.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'help-request',
      (data: any) => {
        const { rawObservation, phrase, label, deferUntilUserMessage } =
          (data ?? {}) as {
            rawObservation?: string;
            phrase?: string;
            label?: string;
            deferUntilUserMessage?: boolean;
          };
        const seed = (rawObservation || phrase || '').trim();
        if (seed) {
          setActivePage('chat');
          setShowSettings(false);
        }
        if (seed && (deferUntilUserMessage || sending)) {
          pendingContextRef.current = seed;
          setPendingContextLabel(
            (phrase || label || 'Tutor suggestion').trim(),
          );
          return;
        }
        if (seed) sendMessage(seed, []);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [sendMessage, sending]);

  // Proactive suggestions from main arrive as Coco messages: unfolded when the
  // chat was open, folded when they first appeared as a pop-up. "Chat about
  // it" on that pop-up reveals the folded copy.
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const cleanupAdd = ipc?.on('chat-suggestion', (data: any) => {
      const { suggestion, folded } = (data ?? {}) as {
        suggestion?: ChatSuggestion;
        folded?: boolean;
      };
      if (!suggestion) return;
      setMessages((current) =>
        suggestion.observationId &&
        current.some(
          (m) => m.suggestion?.observationId === suggestion.observationId,
        )
          ? current
          : [...current, suggestionMessage(suggestion, folded === true)],
      );
      if (!folded) scrollToBottom();
    });
    const cleanupReveal = ipc?.on('reveal-chat-suggestion', (data: any) => {
      const { observationId, suggestion } = (data ?? {}) as {
        observationId?: string;
        suggestion?: ChatSuggestion;
      };
      if (!observationId) return;
      setActivePage('chat');
      setShowSettings(false);
      setReviewing(null);
      setShowHistory(false);
      setMessages((current) => {
        if (
          current.some((m) => m.suggestion?.observationId === observationId)
        ) {
          return current.map((m) =>
            m.suggestion?.observationId === observationId
              ? { ...m, folded: false }
              : m,
          );
        }
        // This chat window never received it (e.g. it was recreated).
        return suggestion
          ? [...current, suggestionMessage(suggestion, false)]
          : current;
      });
      scrollToBottom();
    });
    return () => {
      if (typeof cleanupAdd === 'function') cleanupAdd();
      if (typeof cleanupReveal === 'function') cleanupReveal();
    };
  }, [scrollToBottom]);

  const toggleSuggestionFold = (target: ChatMessage) => {
    const flip = (list: ChatMessage[]) =>
      list.map((m) => (m === target ? { ...m, folded: !m.folded } : m));
    if (reviewing) {
      setReviewing({ ...reviewing, messages: flip(reviewing.messages) });
    } else {
      setMessages(flip);
    }
  };

  // Hot-key screen capture (Cmd/Ctrl+Shift+Space) → preview thumbnail in the
  // input bar, reusing the same pending-image strip that paste drives.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'hotkey-capture',
      (data: any) => {
        const url = (data ?? {}).imageDataUrl as string | undefined;
        if (url) {
          setActivePage('chat');
          setShowSettings(false);
          pendingHotkeyImagesRef.current.add(url);
          setPendingImages((prev) => [...prev, url]);
        }
      },
    );
    // Tell main the listener is live so it can flush any capture that arrived
    // while this window was still loading (e.g. the hot key just opened it).
    window.electron?.ipcRenderer.sendMessage('hotkey-capture-ready');
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () =>
          setPendingImages((prev) => [...prev, String(reader.result)]);
        reader.readAsDataURL(file);
      }
    }
  };

  const resumeConversation = async (conversation: SavedConversation) => {
    const result = await window.electron?.ipcRenderer.invoke(
      'resume-chat-conversation',
      { sessionId: conversation.sessionId },
    );
    if (!result?.success) {
      throw new Error(result?.error || 'Could not restore this conversation.');
    }
    sessionIdRef.current = conversation.sessionId;
    setProblem(conversation.problem);
    setMessages(conversation.messages);
    setCurrentTutorModelId(
      result.tutorModelId || conversation.tutorModelId || currentTutorModelId,
    );
    setRatings({});
    setReviewing(null);
    setShowHistory(false);
  };

  const handleSend = () => {
    if (sending || startingNewSession || checkingUnderstanding) return;
    const imgs = pendingImages;
    const hotkeyImgs = imgs.filter((src) =>
      pendingHotkeyImagesRef.current.has(src),
    );
    const clearSentHotkeyImages = () => {
      hotkeyImgs.forEach((src) => pendingHotkeyImagesRef.current.delete(src));
    };
    const text = input;
    setInput('');
    setPendingImages([]);
    if (reviewing) {
      const conversation = reviewing;
      setSending(true);
      resumeConversation(conversation)
        .then(() => {
          setSending(false);
          sendMessage(text, imgs, hotkeyImgs);
          clearSentHotkeyImages();
        })
        .catch(() => {
          setInput(text);
          setPendingImages(imgs);
          setSending(false);
        });
      return;
    }
    sendMessage(text, imgs, hotkeyImgs);
    clearSentHotkeyImages();
  };

  const handleVoiceClick = async (fromWakeWord = false) => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.stop();
      return;
    }
    if (fromWakeWord) {
      setActivePage('chat');
      setShowSettings(false);
      setShowHistory(false);
      setReviewing(null);
    }
    const unavailable =
      sending ||
      startingNewSession ||
      (!fromWakeWord && reviewing) ||
      voiceState === 'requesting';
    if (unavailable) {
      if (fromWakeWord) {
        await window.electron?.ipcRenderer.invoke(
          'set-wake-word-capture-paused',
          { paused: false },
        );
      }
      return;
    }
    await window.electron?.ipcRenderer.invoke('set-wake-word-capture-paused', {
      paused: true,
    });
    setVoiceError('');
    setVoiceState('requesting');
    let audioData: string | null = null;
    try {
      const recorder = await startVoiceRecorder({
        silenceMs: 2_500,
        maxDurationMs: 30_000,
        onStatus: setVoiceState,
      });
      voiceRecorderRef.current = recorder;
      const recording = await recorder.done;
      audioData = recording.wavBase64;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'Voice recording cancelled.') setVoiceError(message);
    } finally {
      voiceRecorderRef.current = null;
      setVoiceState('idle');
      await window.electron?.ipcRenderer.invoke(
        'set-wake-word-capture-paused',
        { paused: false },
      );
    }
    if (audioData) await sendVoiceMessage(audioData);
  };
  handleVoiceClickRef.current = handleVoiceClick;

  const updateWakeWordEnabled = async (enabled: boolean) => {
    if (wakeWordSaving) return;
    setWakeWordSaving(true);
    setWakeWordCaptureError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'set-wake-word-settings',
        { enabled },
      )) as
        | ({
            success?: boolean;
            error?: string;
          } & Partial<WakeWordSettingsInfo>)
        | undefined;
      if (!result?.success) {
        throw new Error(result?.error ?? 'Could not update voice activation.');
      }
      setWakeWordEnabled(enabled);
      if (result.status) setWakeWordStatus(result.status);
    } catch (error) {
      setWakeWordCaptureError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWakeWordSaving(false);
    }
  };

  const handleNewSession = async () => {
    if (sending || startingNewSession || checkingUnderstanding) return;
    setStartingNewSession(true);
    try {
      await window.electron?.ipcRenderer.invoke('start-new-chat-session', {
        problemStatement: problem,
      });
    } finally {
      setStartingNewSession(false);
    }
  };

  const handleCheckUnderstanding = async () => {
    if (sending || startingNewSession || checkingUnderstanding) return;
    setCheckingUnderstanding(true);
    setUnderstandingError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'check-understanding',
        { sessionId: reviewing?.sessionId ?? sessionIdRef.current },
      )) as { success?: boolean; error?: string } | undefined;
      if (!result?.success) {
        setUnderstandingError(
          result?.error || 'Could not open the understanding check.',
        );
      }
    } catch (error) {
      setUnderstandingError(
        error instanceof Error
          ? error.message
          : 'Could not open the understanding check.',
      );
    } finally {
      setCheckingUnderstanding(false);
    }
  };

  const openHistory = async () => {
    setShowHistory(true);
    if (historyLoading) return;
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const saved = await window.electron?.ipcRenderer.invoke(
        'get-chat-conversations',
      );
      setConversations(
        (Array.isArray(saved) ? saved : []).filter(
          (conversation: SavedConversation) =>
            conversation.sessionId !== sessionIdRef.current,
        ),
      );
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend =
    !sending &&
    !startingNewSession &&
    !checkingUnderstanding &&
    voiceState === 'idle' &&
    (input.trim().length > 0 || pendingImages.length > 0);
  const voiceActive = voiceState === 'listening' || voiceState === 'speaking';
  let voiceStatusText = '';
  if (voiceState === 'requesting') {
    voiceStatusText = 'Requesting microphone access…';
  } else if (voiceState === 'speaking') {
    voiceStatusText = 'Listening… Coco will send after you stop speaking.';
  } else if (voiceState === 'listening') {
    voiceStatusText = 'Listening… start speaking, or press stop to send.';
  }
  const visibleMessages = reviewing?.messages ?? messages;
  const hasRunningTool = visibleMessages.some(
    (message) =>
      message.role === 'tutor' &&
      (message.toolCalls?.some((call) => call.status === 'running') ||
        message.activity?.some(
          (item) => item.kind === 'tool' && item.call.status === 'running',
        )),
  );

  return (
    <DesktopWorkspace
      expanded={expanded}
      onExpandedChange={changeExpanded}
      active={
        showSettings
          ? 'settings'
          : activePage === 'settings'
            ? 'chat'
            : activePage
      }
      historyOpen={showHistory}
      onHistoryOpen={() => void openHistory()}
      onHistoryClose={() => setShowHistory(false)}
      onNavigate={(page) => {
        setActivePage(page);
        setShowSettings(page === 'settings');
        if (page !== 'chat') {
          setShowHistory(false);
          changeExpanded(true);
        }
      }}
      history={
        <ConversationSidebar
          conversations={conversations}
          loading={historyLoading}
          error={historyError}
          selectedId={reviewing?.sessionId}
          onRetry={() => {
            setShowHistory(false);
            void openHistory();
          }}
          onCurrent={() => {
            if (checkingUnderstanding) return;
            setReviewing(null);
            setShowHistory(false);
            setShowSettings(false);
            setActivePage('chat');
          }}
          onSelect={(conversation) => {
            if (checkingUnderstanding) return;
            setUnderstandingError('');
            setReviewing(conversation);
            setShowHistory(false);
            setShowSettings(false);
            setActivePage('chat');
          }}
        />
      }
      details={
        <>
          <div className="workspace-personalization" hidden={showSettings || activePage !== 'personalization'}>
            {activePage === 'personalization' && !showSettings && (
              <PersonalizationCenter onBack={() => setActivePage('chat')} />
            )}
          </div>
          {showSettings && (
            <div className="workspace-settings">
              <h1>Settings</h1>
              <AccountSettings />
              <HealthSettings
                {...{
                  cocoSleeping,
                  systemPermissionHealth,
                  permissionOpening,
                  openSystemPermission,
                  permissionError,
                  serviceHealth,
                  healthLoading,
                  refreshServiceHealth,
                  healthError,
                }}
              />
              <PreferencesSettings
                {...{
                  editHideAvatar,
                  avatarSaving,
                  updateAvatarVisibility,
                  avatarSaveError,
                  wakeWordSaving,
                  wakeWordEnabled,
                  updateWakeWordEnabled,
                  wakeWordCaptureError,
                  wakeWordStatus,
                  wakeWordDetail,
                  cocoSleeping,
                }}
              />
              <MemorySettings
                {...{
                  memoryDraft,
                  setMemoryDraft,
                  memoryDirty,
                  saveMemory,
                  memoryFlash,
                }}
              />
            </div>
          )}
        </>
      }
    >
      <ChatHeader
        chatEnabled
        {...{
          sending,
          startingNewSession,
          handleNewSession,
          expanded,
          changeExpanded,
        }}
      />

      <div style={S.contentViewport}>
        <div
          data-testid="chat-scalable-content"
          style={{
            ...S.scalableContent,
            transform: `scale(${contentZoomFactor})`,
            width: `${100 / contentZoomFactor}%`,
            height: `${100 / contentZoomFactor}%`,
          }}
        >
          <>
              <ChatTranscript
                {...{
                  reviewing,
                  listRef,
                  visibleMessages,
                  sending,
                  profile,
                  startingNewSession,
                  sendMessage,
                  openImagePreview,
                  copiedMessageKey,
                  copyMessage,
                  toggleSuggestionFold,
                  retryMessage,
                  ratings,
                  rateMessage,
                  hasRunningTool,
                }}
              />{' '}
              <ChatComposer
                workspaceSessionId={
                  reviewing?.sessionId ?? sessionIdRef.current
                }
                agentRunning={
                  sending &&
                  messages.some(
                    (m) => m.isStreaming && m.retryRequestKind === 'chat',
                  )
                }
                stopAgent={async () => {
                  const pending = messages.find((m) => m.isStreaming);
                  if (pending?.requestId)
                    await window.electron?.ipcRenderer.invoke(
                      'stop-agent-run',
                      pending.requestId,
                    );
                }}
                {...{
                  pendingContextLabel,
                  pendingContextRef,
                  setPendingContextLabel,
                  pendingImages,
                  openImagePreview,
                  pendingHotkeyImagesRef,
                  setPendingImages,
                  understandingError,
                  sending,
                  voiceState,
                  input,
                  setInput,
                  onPaste,
                  onKeyDown,
                  voiceActive,
                  startingNewSession,
                  reviewing,
                  handleVoiceClick,
                  profile,
                  checkingUnderstanding,
                  handleCheckUnderstanding,
                  canSend,
                  handleSend,
                  voiceStatusText,
                  voiceError,
                }}
              />
          </>
        </div>
      </div>
    </DesktopWorkspace>
  );
}
