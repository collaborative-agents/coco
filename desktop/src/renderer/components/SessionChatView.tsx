import React, { useCallback, useEffect, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import {
  startVoiceRecorder,
  type ActiveVoiceRecorder,
  type VoiceRecorderStatus,
} from '../voice-recorder';
import {
  parseAiTool,
  encodeCustomChatbot,
  encodeCustomAgent,
} from './observation-types';
import type { LLMCallMetrics, TutorToolCall } from './observation-types';
import PersonalizationCenter, {
  PersonalizationSettingsCard,
} from './PersonalizationCenter';
export { PersonalizationStatusPanel } from './PersonalizationCenter';
import type { AgentActivity } from '../../shared/agent-execution';
import type {
  ChatMessage,
  SavedConversation,
  TutorModelOption,
  ServiceHealthView,
  SleepingServiceHealthView,
  WakeWordSettingsInfo,
  ConnectionTestStatus,
} from './chat/types';
import { copyableMessageText, makeMessageId } from './chat/message-format';
import { blankTutorModel } from './chat/constants';
import { S } from './chat/styles';
import ChatHeader from './chat/ChatHeader';
import ChatTranscript from './chat/ChatTranscript';
import ChatComposer from './chat/ChatComposer';
import DesktopWorkspace from './chat/DesktopWorkspace';
import ConversationSidebar from './chat/ConversationSidebar';
import AccountSettings from './chat/AccountSettings';
import ModelSettings from './chat/ModelSettings';
import ProfileSettings from './chat/ProfileSettings';
import VoiceSettings from './chat/VoiceSettings';
import MemorySettings from './chat/MemorySettings';
import HealthSettings from './chat/HealthSettings';
import type {
  SystemPermissionHealth,
  SystemPermissionTarget,
} from './chat/types';
export { ToolCallCard } from './chat/ToolCallCard';
const blankSensingModel: TutorModelOption = {
  id: 'sensing',
  label: 'Sensing',
  provider: 'gemini',
  model: '',
  supportsAudio: false,
};
export interface TrainingScreenshotRetentionInfo {
  enabled: boolean;
  recordsRoot: string;
  screenshotPattern: string;
  configurationPath: string;
}
export function TrainingScreenshotRetentionNotice({
  info,
  onOpenFolder,
}: {
  info: TrainingScreenshotRetentionInfo | null;
  onOpenFolder: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!info?.enabled) return null;
  return (
    <div style={S.retentionNotice} role="note">
      <button
        type="button"
        style={S.retentionToggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span style={S.retentionTitle}>
          You are currently in developer mode
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
          style={{
            ...S.retentionChevron,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <path
            d="m5 7.5 5 5 5-5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded && (
        <div style={S.retentionBody}>
          The developer mode keeps local copies of screenshots, which can
          consume significant disk space. To turn this off, add{' '}
          <strong>COLLECT_TRAINING_SCREENSHOTS=0</strong> to:
          <code style={S.retentionPath}>{info.configurationPath}</code>
          Then restart Coco. Existing images are stored under:
          <code style={S.retentionPath}>{info.screenshotPattern}</code>
          Turning retention off does not remove older copies. Delete the
          <strong> observer_screenshots</strong> folders when Coco is not
          running a personalization update if you want to reclaim that space.
          <div>
            <button
              type="button"
              style={S.retentionButton}
              onClick={() => onOpenFolder(info.recordsRoot)}
            >
              Open local records folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [problem, setProblem] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [contentZoomFactor, setContentZoomFactor] = useState(1);
  const [showSettings, setShowSettings] = useState(false);
  const [showPersonalizationCenter, setShowPersonalizationCenter] =
    useState(false);
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
  const [tutorModels, setTutorModels] = useState<TutorModelOption[]>([]);
  const [currentTutorModelId, setCurrentTutorModelId] = useState('');
  const [sensingModel, setSensingModel] =
    useState<TutorModelOption>(blankSensingModel);
  const [defaultTutorModelId, setDefaultTutorModelId] = useState('');
  const [savedTutorAudioSupport, setSavedTutorAudioSupport] = useState<
    Record<string, boolean>
  >({});
  const currentTutorSupportsAudio =
    savedTutorAudioSupport[currentTutorModelId] === true;
  const [modelCredentials, setModelCredentials] = useState<
    Record<string, string>
  >({});
  const [modelConfigLoading, setModelConfigLoading] = useState(true);
  const [modelLoadError, setModelLoadError] = useState('');
  const [modelSaveError, setModelSaveError] = useState('');
  const [modelSavedFlash, setModelSavedFlash] = useState(false);
  const [systemPermissionHealth, setSystemPermissionHealth] =
    useState<SystemPermissionHealth>({ missing: [] });
  const [permissionOpening, setPermissionOpening] =
    useState<SystemPermissionTarget | null>(null);
  const [permissionError, setPermissionError] = useState('');
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthView | null>(
    null,
  );
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [cocoSleeping, setCocoSleeping] = useState(false);
  const [cocoSleepModeKnown, setCocoSleepModeKnown] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeWordStatus, setWakeWordStatus] =
    useState<WakeWordSettingsInfo['status']>('disabled');
  const [wakeWordDetail, setWakeWordDetail] = useState('');
  const [wakeWordCaptureError, setWakeWordCaptureError] = useState('');
  const [wakeWordSaving, setWakeWordSaving] = useState(false);
  const [connectionTests, setConnectionTests] = useState<
    Record<string, ConnectionTestStatus>
  >({});
  // Editable draft of the settings, synced from the loaded profile.
  const [editScenario, setEditScenario] = useState('everyday_support');
  const [editTools, setEditTools] = useState<string[]>([]);
  const [editHideAvatar, setEditHideAvatar] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarSaveError, setAvatarSaveError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  // "+ Custom" tool forms (mirrors the onboarding toolkit step).
  const [showAddChatbot, setShowAddChatbot] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [cbName, setCbName] = useState('');
  const [cbUrl, setCbUrl] = useState('');
  const [cbDesc, setCbDesc] = useState('');
  const [agName, setAgName] = useState('');
  const [agDesc, setAgDesc] = useState('');
  // Long-term agent memory (loaded from / saved to the tutor server).
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryLoaded, setMemoryLoaded] = useState('');
  const [memoryFlash, setMemoryFlash] = useState(false);
  const [trainingScreenshotRetention, setTrainingScreenshotRetention] =
    useState<TrainingScreenshotRetentionInfo | null>(null);
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
  const conversationSaveTimerRef = useRef<number | null>(null);
  const cocoSleepingRef = useRef(false);
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

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'float-window-state',
      (value) => {
        const state = value as { isFloat?: boolean } | undefined;
        setExpanded(state?.isFloat === false);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const applyCocoSleepMode = useCallback((sleeping: boolean) => {
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
      setHealthLoading(true);
      setHealthError('');
      try {
        const result = (await window.electron?.ipcRenderer.invoke(
          'get-service-health',
          { forceModelTest },
        )) as ServiceHealthView | SleepingServiceHealthView | undefined;
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

  const persistConversationSnapshot = useCallback(
    (flushBeforeUnload = false) => {
      const sessionId = sessionIdRef.current;
      const snapshot = messagesRef.current;
      const ipc = window.electron?.ipcRenderer;
      if (!ipc || !sessionId || snapshot.length === 0) return;
      const payload = {
        sessionId,
        problem: problemRef.current,
        messages: snapshot,
      };
      if (flushBeforeUnload) {
        ipc.sendMessage('save-chat-conversation', payload);
        return;
      }
      return ipc
        .invoke('save-chat-conversation', payload)
        .then(() => undefined)
        .catch(() => undefined);
    },
    [],
  );

  // Persist at most once per interval while streaming, but never postpone the
  // first snapshot. A trailing debounce could be reset by every token and lose
  // an entire conversation if the app quit before the response completed.
  useEffect(() => {
    messagesRef.current = messages;
    problemRef.current = problem;
    if (
      !sessionIdRef.current ||
      messages.length === 0 ||
      conversationSaveTimerRef.current !== null
    ) {
      return;
    }
    conversationSaveTimerRef.current = window.setTimeout(() => {
      conversationSaveTimerRef.current = null;
      void persistConversationSnapshot();
    }, 250);
  }, [messages, persistConversationSnapshot, problem]);

  useEffect(() => {
    const flushConversation = () => {
      if (conversationSaveTimerRef.current !== null) {
        window.clearTimeout(conversationSaveTimerRef.current);
        conversationSaveTimerRef.current = null;
      }
      persistConversationSnapshot(true);
    };
    window.addEventListener('beforeunload', flushConversation);
    return () => {
      window.removeEventListener('beforeunload', flushConversation);
      flushConversation();
    };
  }, [persistConversationSnapshot]);

  // Rate a tutor message. Routed main → sensing /feedback → feedback.jsonl,
  // same pipeline as the bubble reactions.
  const rateMessage = (m: ChatMessage, dir: 'up' | 'down') => {
    if (!m.id || ratings[m.id] === dir) return;
    const previousRating = ratings[m.id];
    setRatings((prev) => ({ ...prev, [m.id as string]: dir }));
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: dir === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
      surface: 'chat',
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
      window.electron?.ipcRenderer.sendMessage('training-feedback', {
        kind: 'copy',
        surface: 'chat',
        message_id: message.id,
        session_id: sessionIdRef.current,
      });
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

  const openImageAnnotator = (imageDataUrl: string) => {
    window.electron?.ipcRenderer.sendMessage('open-image-preview', {
      imageDataUrl,
      editable: true,
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
          messageId?: string;
          type?: string;
          text?: string;
          call?: TutorToolCall;
          guidance?: string;
          error?: string;
          observerMetrics?: LLMCallMetrics | null;
          llm_metrics?: LLMCallMetrics | null;
          tool_calls?: TutorToolCall[];
          activity?: AgentActivity | AgentActivity[];
          stopped?: boolean;
        };
        if (!event.requestId) return;
        if (event.type === 'transcription' && event.text) {
          setMessages((current) => {
            const index = current.findIndex(
              (message) => message.requestId === event.requestId,
            );
            return current.map((message, position) =>
              position === index - 1 && message.role === 'user'
                ? { ...message, text: event.text!.trim() || message.text }
                : message,
            );
          });
          return;
        }
        setMessages((current) =>
          current.map((message) => {
            if (message.requestId !== event.requestId) return message;
            if (
              event.type === 'agent_activity' &&
              Array.isArray(event.activity)
            ) {
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
                id: event.messageId ?? message.id ?? makeMessageId(),
                ts: Date.now(),
                observerMetrics: event.observerMetrics ?? null,
                tutorMetrics: event.llm_metrics ?? null,
                toolCalls: event.tool_calls ?? message.toolCalls ?? [],
                activity: Array.isArray(event.activity)
                  ? event.activity
                  : message.activity,
                stopped: event.stopped === true,
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
          }),
        );
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
      hotkeyImages: string[] = [],
    ) => {
      setSending(true);
      scrollToBottom();
      const res = await window.electron?.ipcRenderer.invoke(
        'send-chat-message',
        {
          requestId,
          userText,
          images,
          hotkeyImages,
        },
      );
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
      const res = await window.electron?.ipcRenderer.invoke(
        'send-audio-message',
        {
          requestId,
          audioData,
        },
      );
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
    async (text: string, images: string[], hotkeyImages: string[] = []) => {
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
          retryHotkeyImages: hotkeyImages,
        },
      ]);
      pendingContextRef.current = null;
      setPendingContextLabel(null);
      await submitTutorRequest(requestId, userText, images, hotkeyImages);
    },
    [submitTutorRequest],
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (sending || startingNewSession || message.retryText === undefined)
        return;
      const previousRequestId = message.requestId;
      const requestId = makeMessageId();
      const images = message.retryImages ?? [];
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
              }
            : item,
        ),
      );
      await submitTutorRequest(
        requestId,
        message.retryText,
        images,
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
              setMessages((current) =>
                current.length === 0
                  ? conversation.messages
                  : [...conversation.messages, ...current],
              );
              setProblem(
                problemStatement?.trim()
                  ? problemStatement
                  : conversation.problem,
              );
            })
            .catch(() => {});
        }
        setProblem(problemStatement ?? '');
        setShowSettings(false);
        setShowPersonalizationCenter(false);
        setReviewing(null);
        setShowHistory(false);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // Load the user's onboarding profile (mode + AI tools) for the Settings panel.
  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-model-configuration')
      .then((config: any) => {
        if (
          !config?.sensing ||
          !Array.isArray(config.tutors) ||
          config.tutors.length === 0
        ) {
          const tutor = blankTutorModel();
          setTutorModels([tutor]);
          setSavedTutorAudioSupport({ [tutor.id]: false });
          setDefaultTutorModelId(tutor.id);
          setModelLoadError(
            'No saved model configuration was found. Configure the sensing and tutor models below.',
          );
          return;
        }
        const normalizedTutors = config.tutors.map(
          (model: TutorModelOption) => ({
            ...model,
            model: model.model.replace(/^(?:hosted_vllm|tinker)\//, ''),
            supportsAudio: model.supportsAudio === true,
          }),
        );
        setTutorModels(normalizedTutors);
        setSavedTutorAudioSupport(
          Object.fromEntries(
            normalizedTutors.map((model: TutorModelOption) => [
              model.id,
              model.supportsAudio,
            ]),
          ),
        );
        setSensingModel({
          ...config.sensing,
          model: String(config.sensing.model).replace(
            /^(?:hosted_vllm|tinker)\//,
            '',
          ),
          supportsAudio: false,
        });
        setDefaultTutorModelId(config.defaultTutorId || '');
        setCurrentTutorModelId(
          (current) => current || config.defaultTutorId || '',
        );
      })
      .catch((error: unknown) => {
        const tutor = blankTutorModel();
        setTutorModels([tutor]);
        setSavedTutorAudioSupport({ [tutor.id]: false });
        setDefaultTutorModelId(tutor.id);
        setModelLoadError(
          `Could not load saved model settings: ${
            error instanceof Error ? error.message : String(error)
          }. You can configure them below.`,
        );
      })
      .finally(() => setModelConfigLoading(false));
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((p: any) => {
        if (!p) return;
        const next = {
          scenario:
            typeof p.tutorScenario === 'string'
              ? p.tutorScenario
              : 'everyday_support',
          aiTools: Array.isArray(p.aiTools) ? p.aiTools : [],
          hideAvatar: p.hideAvatar === true,
        };
        setProfile(next);
        setEditScenario(next.scenario);
        setEditTools(next.aiTools);
        setEditHideAvatar(next.hideAvatar);
      })
      .catch(() => {});
  }, []);

  const testSettingsModelConnection = async (
    role: 'sensing' | 'tutor',
    model: TutorModelOption,
  ) => {
    const key = role === 'sensing' ? 'sensing' : model.id;
    if (!model.model.trim()) {
      setConnectionTests((current) => ({
        ...current,
        [key]: { state: 'error', message: 'Enter a model ID first.' },
      }));
      return;
    }
    setConnectionTests((current) => ({
      ...current,
      [key]: { state: 'testing', message: '' },
    }));
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'test-model-connection',
        {
          role,
          routing: 'direct',
          connection: {
            id: model.id,
            label: model.label || (role === 'sensing' ? 'Sensing' : 'Tutor'),
            provider: model.provider,
            model: model.model,
            baseUrl: model.baseUrl,
          },
          apiKey: modelCredentials[`${role}:${model.provider}`] ?? '',
        },
      )) as { success?: boolean; message?: string; error?: string } | undefined;
      setConnectionTests((current) => ({
        ...current,
        [key]: result?.success
          ? { state: 'success', message: result.message || 'Connected.' }
          : { state: 'error', message: result?.error || 'Connection failed.' },
      }));
    } catch (error) {
      setConnectionTests((current) => ({
        ...current,
        [key]: {
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const saveModelSettings = async () => {
    if (modelConfigLoading) return;
    setModelSaveError('');
    if (!sensingModel.model.trim()) {
      setModelSaveError('Enter a vision-capable sensing model.');
      return;
    }
    if (
      tutorModels.length === 0 ||
      tutorModels.some((model) => !model.label.trim() || !model.model.trim())
    ) {
      setModelSaveError(
        'Add at least one tutor with a display name and model ID.',
      );
      return;
    }
    const result = await window.electron?.ipcRenderer.invoke(
      'save-model-configuration',
      {
        routing: 'direct',
        sensing: sensingModel,
        tutors: tutorModels,
        defaultTutorId: defaultTutorModelId,
        credentials: modelCredentials,
      },
    );
    if (!(result as { success?: boolean })?.success) {
      setModelSaveError(
        (result as { error?: string })?.error ||
          'Could not save model settings.',
      );
      return;
    }
    setModelCredentials({});
    setSavedTutorAudioSupport(
      Object.fromEntries(
        tutorModels.map((model) => [model.id, model.supportsAudio]),
      ),
    );
    setVoiceError('');
    setModelLoadError('');
    setModelSavedFlash(true);
    setTimeout(() => setModelSavedFlash(false), 1500);
  };

  const toggleEditTool = (id: string) =>
    setEditTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );

  const addCustomChatbot = () => {
    if (!cbName.trim() || !cbUrl.trim()) return;
    setEditTools((prev) => [
      ...prev,
      encodeCustomChatbot(cbName, cbUrl, cbDesc),
    ]);
    setCbName('');
    setCbUrl('');
    setCbDesc('');
    setShowAddChatbot(false);
  };
  const addCustomAgent = () => {
    if (!agName.trim()) return;
    setEditTools((prev) => [...prev, encodeCustomAgent(agName, agDesc)]);
    setAgName('');
    setAgDesc('');
    setShowAddAgent(false);
  };
  // Display label for a custom-tool id (parseAiTool resolves custom chatbots;
  // custom agents carry no launch target, so decode the name from the id).
  const customLabel = (id: string) =>
    parseAiTool(id)?.label ??
    id.replace(/^custom_(chatbot|agent):/, '').split('|')[0] ??
    id;

  const saveSettings = async () => {
    const res = await window.electron?.ipcRenderer.invoke('update-settings', {
      scenario: editScenario,
      aiTools: editTools,
      hideAvatar: editHideAvatar,
    });
    if ((res as { success?: boolean })?.success) {
      setProfile({
        scenario: editScenario,
        aiTools: editTools,
        hideAvatar: editHideAvatar,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    }
  };

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

  const dirty =
    editScenario !== profile.scenario ||
    editTools.length !== profile.aiTools.length ||
    editTools.some((t) => !profile.aiTools.includes(t));

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
    window.electron?.ipcRenderer
      .invoke('get-training-screenshot-retention')
      .then((info: TrainingScreenshotRetentionInfo) => {
        setTrainingScreenshotRetention(info);
      })
      .catch(() => setTrainingScreenshotRetention(null));
  }, [showSettings]);

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-coco-sleep-mode')
      .then((result: { sleeping?: boolean } | undefined) => {
        applyCocoSleepMode(result?.sleeping === true);
      })
      .catch(() => applyCocoSleepMode(false));
    const cleanup = window.electron?.ipcRenderer.on(
      'coco-sleep-mode-changed',
      (...args: unknown[]) => {
        const result = args[0] as { sleeping?: boolean } | undefined;
        applyCocoSleepMode(result?.sleeping === true);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [applyCocoSleepMode]);

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
        setShowPersonalizationCenter(false);
        setShowHistory(false);
        setReviewing(null);
        setShowSettings(true);
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
  // sent immediately; "Chat about it" stages context for the next message; and
  // "Open Coco Chat" places a delegation prompt directly in the composer.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'help-request',
      (data: any) => {
        const {
          rawObservation,
          phrase,
          label,
          deferUntilUserMessage,
          initialInput,
        } = (data ?? {}) as {
          rawObservation?: string;
          phrase?: string;
          label?: string;
          deferUntilUserMessage?: boolean;
          initialInput?: string;
        };
        if (typeof initialInput === 'string') {
          setInput(initialInput);
          return;
        }
        const seed = (rawObservation || phrase || '').trim();
        if (seed && deferUntilUserMessage) {
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
  }, [sendMessage]);

  // Hot-key screen capture (Cmd/Ctrl+Shift+Space) → preview thumbnail in the
  // input bar, reusing the same pending-image strip that paste drives.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'hotkey-capture',
      (data: any) => {
        const url = (data ?? {}).imageDataUrl as string | undefined;
        if (url) {
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

  // The full-screen annotator sends back a flattened PNG. Replace the original
  // pending capture while retaining its hot-key provenance for the tutor.
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'image-annotation-saved',
      (data: any) => {
        const original = (data ?? {}).originalImageDataUrl as
          | string
          | undefined;
        const annotated = (data ?? {}).imageDataUrl as string | undefined;
        if (
          !original ||
          !annotated?.startsWith('data:image/') ||
          !pendingHotkeyImagesRef.current.has(original)
        ) {
          return;
        }
        pendingHotkeyImagesRef.current.delete(original);
        pendingHotkeyImagesRef.current.add(annotated);
        setPendingImages((current) =>
          current.map((image) => (image === original ? annotated : image)),
        );
      },
    );
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

  const handleSend = () => {
    if (sending || startingNewSession) return;
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
      window.electron?.ipcRenderer
        .invoke('resume-chat-conversation', {
          sessionId: conversation.sessionId,
        })
        .then((result: any) => {
          if (!result?.success) {
            setInput(text);
            setPendingImages(imgs);
            setSending(false);
            return;
          }
          sessionIdRef.current = conversation.sessionId;
          setProblem(conversation.problem);
          setMessages(conversation.messages);
          setCurrentTutorModelId(
            result.tutorModelId ||
              conversation.tutorModelId ||
              currentTutorModelId,
          );
          setRatings({});
          setReviewing(null);
          setShowHistory(false);
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
      setShowSettings(false);
      setShowHistory(false);
      setReviewing(null);
    }
    if (!currentTutorSupportsAudio) {
      if (fromWakeWord) {
        setVoiceError(
          'Coco is awake, but the selected tutor does not support audio input. Type your message or choose an audio-capable tutor.',
        );
        await window.electron?.ipcRenderer.invoke(
          'set-wake-word-capture-paused',
          { paused: false },
        );
      }
      return;
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
    if (sending || startingNewSession) return;
    setStartingNewSession(true);
    try {
      await window.electron?.ipcRenderer.invoke('start-new-chat-session', {
        problemStatement: problem,
      });
    } finally {
      setStartingNewSession(false);
    }
  };

  const openHistory = async (force = false) => {
    if (showHistory && !force) return;
    setShowHistory(true);
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      await persistConversationSnapshot();
      const saved = await window.electron?.ipcRenderer.invoke(
        'get-chat-conversations',
      );
      setConversations(Array.isArray(saved) ? saved : []);
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isImeComposing =
      e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend =
    !sending &&
    !startingNewSession &&
    voiceState === 'idle' &&
    (input.trim().length > 0 || pendingImages.length > 0);
  const voiceActive = voiceState === 'listening' || voiceState === 'speaking';
  const voiceButtonDisabled =
    sending ||
    startingNewSession ||
    Boolean(reviewing) ||
    voiceState === 'requesting' ||
    !currentTutorSupportsAudio;
  let voiceButtonLabel = 'Start voice recording';
  if (voiceActive) {
    voiceButtonLabel = 'Stop voice recording';
  } else if (!currentTutorSupportsAudio) {
    voiceButtonLabel =
      'Voice input unavailable: selected tutor does not support audio';
  }
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
      message.toolCalls?.some((call) => call.status === 'running'),
  );
  const sensingUnavailable =
    !cocoSleeping && serviceHealth?.sensing.connected === false;
  const tutorUnavailable =
    !cocoSleeping && serviceHealth?.tutor.connected === false;
  const serviceUnavailable = sensingUnavailable || tutorUnavailable;
  const modelUnavailable = Boolean(
    !cocoSleeping &&
      serviceHealth &&
      [serviceHealth.sensing, serviceHealth.tutor].some(
        (health) => health.modelAssessment?.status === 'failed',
      ),
  );
  const modelsVerified = Boolean(
    !cocoSleeping &&
      serviceHealth &&
      [serviceHealth.sensing, serviceHealth.tutor].every(
        (health) => health.modelAssessment?.status === 'verified',
      ),
  );
  const modelConfigurationIssue = Boolean(
    !cocoSleeping &&
      serviceHealth &&
      [serviceHealth.sensing, serviceHealth.tutor].some(
        (health) =>
          health.modelAssessment?.status === 'legacy_unassessed' ||
          health.modelAssessment?.status === 'not_configured',
      ),
  );
  const chatHealthLabel = cocoSleeping
    ? 'Sleeping'
    : serviceUnavailable
      ? 'Service issue'
      : modelUnavailable
        ? 'Model issue'
        : modelConfigurationIssue
          ? 'Configure models'
          : serviceHealth
            ? modelsVerified
              ? 'Connected'
              : 'Services reachable'
            : healthLoading
              ? 'Checking health…'
              : 'Health unknown';
  const chatHealthColor = cocoSleeping
    ? '#6b7280'
    : serviceUnavailable || modelUnavailable
      ? '#dc2626'
      : modelConfigurationIssue
        ? '#b45309'
        : modelsVerified
          ? '#16a34a'
          : '#6b7280';
  const chatHealthTitle = cocoSleeping
    ? 'Screen observation is asleep. Text chat remains available.'
    : serviceUnavailable
      ? [
          sensingUnavailable ? 'Sensing server is not reachable.' : '',
          tutorUnavailable ? 'Tutor agent is not reachable.' : '',
          'Click to open Settings.',
        ]
          .filter(Boolean)
          .join(' ')
      : modelUnavailable
        ? [
            serviceHealth?.sensing.modelAssessment?.status === 'failed'
              ? `Sensing model: ${serviceHealth.sensing.modelAssessment.detail}`
              : '',
            serviceHealth?.tutor.modelAssessment?.status === 'failed'
              ? `Tutor model: ${serviceHealth.tutor.modelAssessment.detail}`
              : '',
            'Click to open Settings.',
          ]
            .filter(Boolean)
            .join(' ')
        : modelConfigurationIssue
          ? 'A saved model configuration is required. Click to open Settings.'
          : serviceHealth
            ? 'Local services and configured models passed their connection tests.'
            : 'Checking local service health.';
  const hasChatHealthIssue =
    !cocoSleeping &&
    (serviceUnavailable || modelUnavailable || modelConfigurationIssue);

  const changeExpanded = (value: boolean) => {
    setExpanded(value);
    window.electron?.ipcRenderer.sendMessage('set-chat-window-expanded', {
      expanded: value,
    });
  };
  const navigate = (page: 'chat' | 'personalization' | 'settings') => {
    setShowSettings(page === 'settings');
    setShowPersonalizationCenter(page === 'personalization');
    setShowHistory(false);
    if (page !== 'chat') changeExpanded(true);
  };
  const toggleSuggestionFold = (target: ChatMessage) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === target.id
          ? { ...message, folded: !message.folded }
          : message,
      ),
    );
  };
  return (
    <DesktopWorkspace
      expanded={expanded}
      onExpandedChange={changeExpanded}
      active={
        showSettings
          ? 'settings'
          : showPersonalizationCenter
            ? 'personalization'
            : 'chat'
      }
      historyOpen={showHistory}
      onHistoryOpen={() => void openHistory()}
      onHistoryClose={() => setShowHistory(false)}
      onNavigate={navigate}
      history={
        <ConversationSidebar
          conversations={conversations}
          loading={historyLoading}
          error={historyError}
          selectedId={reviewing?.sessionId}
          onRetry={() => {
            void openHistory(true);
          }}
          onCurrent={() => {
            setReviewing(null);
            navigate('chat');
          }}
          onSelect={(conversation) => {
            if (sending) return;
            setReviewing(conversation);
            navigate('chat');
          }}
        />
      }
      details={
        <>
          {showPersonalizationCenter && (
            <PersonalizationCenter onBack={() => navigate('chat')} />
          )}
          {showSettings && (
            <div className="workspace-settings">
              <h1>Settings</h1>
              <AccountSettings />
              <button
                type="button"
                style={S.saveBtn}
                onClick={() =>
                  window.electron?.ipcRenderer.sendMessage('auth-logout')
                }
              >
                Log out
              </button>
              <TrainingScreenshotRetentionNotice
                info={trainingScreenshotRetention}
                onOpenFolder={(folderPath) =>
                  window.electron?.ipcRenderer.sendMessage(
                    'shell-show-item-in-finder',
                    folderPath,
                  )
                }
              />
              <section className="workspace-settings-section">
                <h2>Personalization</h2>
                <PersonalizationSettingsCard
                  onOpen={() => navigate('personalization')}
                />
              </section>
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
              <ModelSettings
                routerManaged={false}
                {...{
                  modelConfigLoading,
                  modelLoadError,
                  sensingModel,
                  setSensingModel,
                  modelCredentials,
                  setModelCredentials,
                  connectionTests,
                  testSettingsModelConnection,
                  tutorModels,
                  setTutorModels,
                  defaultTutorModelId,
                  setDefaultTutorModelId,
                  saveModelSettings,
                  modelSavedFlash,
                  modelSaveError,
                }}
              />
              <ProfileSettings
                supportedModes={[
                  'student_learning',
                  'everyday_support',
                  'ai_upskilling',
                  'custom',
                ]}
                {...{
                  editHideAvatar,
                  avatarSaving,
                  updateAvatarVisibility,
                  avatarSaveError,
                  editScenario,
                  setEditScenario,
                  editTools,
                  toggleEditTool,
                  customLabel,
                  setShowAddChatbot,
                  showAddChatbot,
                  cbName,
                  setCbName,
                  cbUrl,
                  setCbUrl,
                  cbDesc,
                  setCbDesc,
                  addCustomChatbot,
                  setShowAddAgent,
                  showAddAgent,
                  agName,
                  setAgName,
                  agDesc,
                  setAgDesc,
                  addCustomAgent,
                  dirty,
                  saveSettings,
                  savedFlash,
                }}
              />
              <VoiceSettings
                {...{
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
        showHealth={!serviceUnavailable}
        chatEnabled
        {...{
          chatHealthLabel,
          chatHealthColor,
          chatHealthTitle,
          hasChatHealthIssue,
          setShowHistory,
          setReviewing,
          setShowSettings,
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
          />
          <ChatComposer
            workspaceSessionId={reviewing?.sessionId ?? sessionIdRef.current}
            agentRunning={sending}
            stopAgent={async () => {
              const pending = messages.find((message) => message.isStreaming);
              if (pending?.requestId)
                await window.electron?.ipcRenderer.invoke(
                  'stop-agent-run',
                  pending.requestId,
                );
            }}
            voiceButtonDisabled={voiceButtonDisabled}
            voiceButtonLabel={voiceButtonLabel}
            finishTaskError=""
            finishingTask={false}
            handleFinishTask={async () => {}}
            {...{
              pendingContextLabel,
              pendingContextRef,
              setPendingContextLabel,
              pendingImages,
              openImagePreview,
              openImageAnnotator,
              pendingHotkeyImagesRef,
              setPendingImages,
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
              canSend,
              handleSend,
              voiceStatusText,
              voiceError,
            }}
          />
        </div>
      </div>
    </DesktopWorkspace>
  );
}
