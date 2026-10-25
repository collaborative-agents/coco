import subscribeCocoSleepMode from './services/coco-sleep-mode';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import type { BubbleState } from './components/ObservationBubble';
import PetSprite from './components/PetSprite';
import usePetPointer from './components/usePetPointer';
import {
  InstantSuggestion,
  ObservationEvent,
  ObservationStatus,
  PetMood,
  STATUS_LABEL,
  STATUS_TO_MOOD,
  cleanObservation,
  pickPhrase,
} from './components/observation-types';
import type { AvatarMenuAction } from './components/AvatarMenuView';
import type { AvatarBubbleEvent } from './components/AvatarBubbleView';

// How long the bubble (and the active pet mood) stay up after the latest event.
const HOLD_MS = 20_000;
// Tutor notifications carry real guidance, so keep them visible longer.
const TUTOR_HOLD_MS = 30_000;
// CSS transition for the bubble fade-out.
const FADE_MS = 400;
// Pulse ring is shown for one second per new event.
const PULSE_MS = 1_000;



/**
 * Statuses that represent mid-friction observations (Tier 2).
 * These show a delayed "Help me with this" button.
 * Positive statuses (progress, observing) are Tier 1 — no button.
 * Tutor guidance arrives via the tutor-notification IPC channel (Tier 3).
 */
const TIER2_STATUSES = new Set<ObservationStatus>([
  'support_needed',
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'discernment_opportunity',
]);

// ── Pet View ──────────────────────────────────────────────────────────────────

function PetView() {
  usePetPointer();
  // Start in `dormant` (static sleep1.png, no animation) until the first
  // observation event arrives. After that the state machine takes over and
  // dormant is never re-entered for the lifetime of the window.
  const [mood, setMood] = useState<PetMood>('dormant');
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const [pulse, setPulse] = useState<{
    status: ObservationStatus;
    key: number;
  } | null>(null);

  const [cocoSleeping, setCocoSleeping] = useState(false);
  // Mirrors whether the ••• menu window is open, for the trigger's styling.
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const menuActionRef = useRef<(action: AvatarMenuAction) => void>(() => {});
  // While Coco is dragged the pointer stays over it, so its hover controls
  // are hidden until the drag ends.
  const [dragging, setDragging] = useState(false);
  const bubbleEventRef = useRef<(type: AvatarBubbleEvent) => void>(() => {});

  // Use refs so listener captures the latest cleanup targets without
  // re-subscribing every render.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseKeyRef = useRef(0);
  // Hover-to-keep: while the pointer is over the bubble, the auto-hide is
  // paused so the user can read / copy the suggested prompt. holdMsRef carries
  // the duration to restart with once the pointer leaves.
  const bubbleHoverRef = useRef(false);
  const holdMsRef = useRef(HOLD_MS);
  // Once the user reveals a suggestion ("Help me with this"), the bubble is
  // pinned: it never auto-hides and can only be closed with the × button.
  const bubblePinnedRef = useRef(false);

  // Arm the bubble's auto-hide after `holdMs`. Skipped while the pointer is
  // over the bubble (handleBubbleLeave re-arms it on exit) so a suggestion the
  // user is reading or copying never vanishes mid-read. Explicit actions
  // (dismiss / help) fade immediately and don't route through here.
  const scheduleBubbleHide = (holdMs: number) => {
    holdMsRef.current = holdMs;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    if (bubblePinnedRef.current) return; // pinned suggestion — stays until ×
    if (bubbleHoverRef.current) return; // paused — re-armed on mouse leave
    hideTimer.current = setTimeout(() => {
      setBubble((b) => (b ? { ...b, fadingOut: true } : null));
      fadeTimer.current = setTimeout(() => {
        setBubble(null);
        setMood('idle');
      }, FADE_MS);
    }, holdMs);
  };

  const handleBubbleEnter = () => {
    if (bubble?.agentReply || bubble?.agentWorking) return;
    bubbleHoverRef.current = true;
    // Cancel any pending hide / in-flight fade and bring it fully back.
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setBubble((b) => (b && b.fadingOut ? { ...b, fadingOut: false } : b));
  };

  const handleBubbleLeave = () => {
    if (bubble?.agentReply || bubble?.agentWorking) return;
    bubbleHoverRef.current = false;
    if (bubblePinnedRef.current) return; // pinned suggestion — never re-arm hide
    if (bubble) scheduleBubbleHide(holdMsRef.current);
  };

  // The menu has its own window; main places it next to Coco and toggles it.
  const openActionsMenu = () =>
    window.electron?.ipcRenderer.sendMessage('open-avatar-menu');

  useEffect(() => {
    const cleanupMenuVisibility = window.electron?.ipcRenderer.on(
      'avatar-menu-visibility',
      (value: unknown) => {
        setActionsMenuOpen(
          (value as { open?: boolean } | undefined)?.open === true,
        );
      },
    );
    const cleanupMenuAction = window.electron?.ipcRenderer.on(
      'avatar-menu-action',
      (action: unknown) => menuActionRef.current(action as AvatarMenuAction),
    );
    const cleanupBubbleEvent = window.electron?.ipcRenderer.on(
      'avatar-bubble-event',
      (type: unknown) => bubbleEventRef.current(type as AvatarBubbleEvent),
    );
    const cleanupDragging = window.electron?.ipcRenderer.on(
      'avatar-dragging',
      (value: unknown) =>
        setDragging((value as { dragging?: boolean })?.dragging === true),
    );
    return () => {
      if (typeof cleanupMenuVisibility === 'function') cleanupMenuVisibility();
      if (typeof cleanupMenuAction === 'function') cleanupMenuAction();
      if (typeof cleanupBubbleEvent === 'function') cleanupBubbleEvent();
      if (typeof cleanupDragging === 'function') cleanupDragging();
    };
  }, []);

  const sleepingRef = useRef(false);
  const applySleepMode = useCallback((sleeping: boolean) => {
    sleepingRef.current = sleeping;
    setCocoSleeping(sleeping);
    if (!sleeping || bubbleRef.current?.agentReply || bubbleRef.current?.agentWorking) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    bubbleHoverRef.current = false;
    bubblePinnedRef.current = false;
    setBubble(null);
    setPulse(null);
    setMood('idle');
  }, []);

  useEffect(() => subscribeCocoSleepMode(applySleepMode), [applySleepMode]);

  const setCocoSleepMode = async (sleeping: boolean) => {
    const result = (await window.electron?.ipcRenderer.invoke(
      'set-coco-sleep-mode',
      { sleeping },
    )) as { success?: boolean; sleeping?: boolean } | undefined;
    if (result?.success) {
      applySleepMode(result.sleeping === true);
    }
  };


  useEffect(() => {
    const cleanupSuspend = window.electron?.ipcRenderer.on(
      'system-suspend',
      () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (pulseTimer.current) clearTimeout(pulseTimer.current);
        bubbleHoverRef.current = false;
        bubblePinnedRef.current = false;
        setBubble(null);
        setPulse(null);
        setMood('dormant');
      },
    );

    const cleanup = window.electron?.ipcRenderer.on(
      'observation-update',
      (data: any) => {
        if (sleepingRef.current) return;
        const event = data as ObservationEvent;
        // Skip the SSE handshake event ({type: "ready"}) and any payload
        // missing an actual observation string.
        if (event?.type === 'ready') return;
        if (!event?.observation) return;

        const incomingStatus: ObservationStatus =
          (event.status as ObservationStatus) ?? 'observing';
        // task_suggested / task_complete are handled by main.ts for the
        // notification flow — they are not avatar states. Skip them here so
        // PetSprite never receives an unknown mood.
        if (!(incomingStatus in STATUS_TO_MOOD)) return;
        // A revealed suggestion is pinned until the user closes it. Continue
        // recording new observations in main, but do not replace the accepted
        // suggestion on the avatar surface.
        if (bubblePinnedRef.current) return;
        // Seed phrase choice on the event timestamp so re-renders are stable.
        const seed = Math.floor((event.ts ?? Date.now() / 1000) * 1000);
        const phrase = pickPhrase(incomingStatus, seed);

        // Clear any in-flight timers — we're starting a fresh visible window.
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (pulseTimer.current) clearTimeout(pulseTimer.current);
        // A brand-new bubble takes over: reset hover + pinned state. (React won't
        // fire mouseleave if the previous bubble unmounted under the cursor, so
        // this prevents a stale flag from pausing/pinning the new bubble forever.)
        bubbleHoverRef.current = false;
        bubblePinnedRef.current = false;

        // Clean raw observation text for storage in bubble state.
        // This is forwarded to the webapp when the user taps "Help me with this"
        // so the chat thread shows what exactly the system noticed.
        const rawObservation = cleanObservation(event.observation);

        // Tier 2 statuses show the "Help me with this" button immediately.
        const showHelpButton = TIER2_STATUSES.has(incomingStatus);

        // Show the bubble + matching pet animation.
        setBubble({ status: incomingStatus, phrase, fadingOut: false, showHelpButton, rawObservation, observationId: event.observation_id });
        setMood(STATUS_TO_MOOD[incomingStatus]);

        // Log that an actionable suggestion was actually shown, so the training
        // stage can derive "ignore" (shown with no engage/dismiss) precisely.

        // Pulse ring around the pet — incrementing the key restarts the CSS
        // animation even if it's the same status as before.
        pulseKeyRef.current += 1;
        setPulse({ status: incomingStatus, key: pulseKeyRef.current });
        pulseTimer.current = setTimeout(() => setPulse(null), PULSE_MS);

        // After HOLD_MS: fade the bubble out and drop the pet back to idle.
        // (Paused while the pointer is over the bubble.)
        scheduleBubbleHide(HOLD_MS);
      },
    );

    return () => {
      if (typeof cleanupSuspend === 'function') cleanupSuspend();
      if (typeof cleanup === 'function') cleanup();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const cleanup = ipc?.on('agent-working', (data: any) => {
      if (!data?.sessionId || !data?.requestId || !data?.text) return;
      // Do not replace a suggestion the user is reading or a completion reminder.
      if (bubblePinnedRef.current || bubbleHoverRef.current) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      bubblePinnedRef.current = true;
      setPulse(null);
      setBubble({ status: 'observing', phrase: '', fadingOut: false,
        tutorMessage: data.text,
        agentWorking: { sessionId: data.sessionId, requestId: data.requestId } });
      setMood('write');
      hideTimer.current = setTimeout(() => {
        bubblePinnedRef.current = false;
        setBubble(null);
        setMood('idle');
      }, 6000);
    });
    const cleanupEnd = ipc?.on('agent-work-ended', (data: any) => {
      if (bubbleRef.current?.agentWorking?.requestId !== data?.requestId) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      bubblePinnedRef.current = false;
      setBubble(null);
      setMood('idle');
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
      if (typeof cleanupEnd === 'function') cleanupEnd();
    };
  }, []);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on('agent-reply-ready', (data: any) => {
      if (!data?.sessionId || !data?.requestId) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      bubbleHoverRef.current = false;
      bubblePinnedRef.current = true; // Keep observations from replacing the reminder.
      setPulse(null);
      setBubble({
        status: 'progress', phrase: '', fadingOut: false,
        tutorMessage: 'Your reply is ready.', agentReply: data,
      });
      setMood('write');
      // Animate for the reminder's full lifetime; opening, dismissal, or expiry
      // returns Coco to idle. No repeat reminders.
      holdMsRef.current = 8000;
      hideTimer.current = setTimeout(() => {
        bubblePinnedRef.current = false;
        setBubble(null);
        setMood('idle');
      }, 8000);
    });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  // ── Tier 3: tutor notification routed from main when webapp is hidden ────────
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'tutor-notification',
      (data: any) => {
        const message = String((data as { message?: unknown })?.message ?? '');
        if (!message) return;
        if (bubblePinnedRef.current) return;

        // Tier 3 replaces any in-flight observation, including Tier 2.
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (pulseTimer.current) clearTimeout(pulseTimer.current);
        bubbleHoverRef.current = false; // fresh bubble — reset hover state
        bubblePinnedRef.current = false;

        setBubble({
          status: 'ai_struggle',   // purple — tutor attention theme
          phrase: '',
          fadingOut: false,
          tutorMessage: message,
        });
        setMood('tool');

        pulseKeyRef.current += 1;
        setPulse({ status: 'ai_struggle', key: pulseKeyRef.current });
        pulseTimer.current = setTimeout(() => setPulse(null), PULSE_MS);

        // Keep tutor guidance visible longer than a regular observation.
        // (Paused while the pointer is over the bubble.)
        scheduleBubbleHide(TUTOR_HOLD_MS);
      },
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, []);

  // ── Session invite: Coco offers a session for the task it detected ──────────
  // It previews a suggestion's title, or shows the task when there is none.
  // The invite is pinned so observations don't replace it. Main clears it when
  // it is ignored or a session starts another way.
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const cleanupInvite = ipc?.on('session-invite', (data: any) => {
      const {
        inviteId,
        taskLabel,
        observationId,
        rawObservation,
        suggestionTitle,
      } = (data ?? {}) as {
        inviteId?: string;
        taskLabel?: string;
        observationId?: string;
        rawObservation?: string;
        suggestionTitle?: string;
      };
      if (!inviteId || !taskLabel) return;
      // Don't replace a suggestion the user opened; main shows the invite as
      // a pop-up instead.
      if (bubblePinnedRef.current) {
        ipc?.sendMessage('session-invite-busy', { inviteId });
        return;
      }
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      bubbleHoverRef.current = false;
      bubblePinnedRef.current = true;
      setBubble({
        status: 'inefficient',
        phrase: suggestionTitle || taskLabel,
        fadingOut: false,
        showHelpButton: true,
        rawObservation,
        observationId,
        invite: { inviteId, hasPreview: Boolean(suggestionTitle) },
      });
      setMood(STATUS_TO_MOOD.inefficient);
      pulseKeyRef.current += 1;
      setPulse({ status: 'inefficient', key: pulseKeyRef.current });
      pulseTimer.current = setTimeout(() => setPulse(null), PULSE_MS);
      ipc?.sendMessage('session-invite-shown', { inviteId });
    });
    const cleanupClear = ipc?.on('session-invite-clear', (data: any) => {
      const { inviteId } = (data ?? {}) as { inviteId?: string };
      if (bubbleRef.current?.invite?.inviteId !== inviteId) return;
      bubblePinnedRef.current = false;
      setBubble(null);
      setMood('idle');
    });
    return () => {
      if (typeof cleanupInvite === 'function') cleanupInvite();
      if (typeof cleanupClear === 'function') cleanupClear();
    };
  }, []);

  // Opening chat is an explicit menu action. If a Tier-1
  // ("progress"/"observing") bubble is showing — i.e. the system offered no
  // proactive suggestion — record the action as a false-negative signal.
  const handleOpenChat = (e?: SyntheticEvent) => {
    e?.stopPropagation?.();
    window.electron?.ipcRenderer.sendMessage('open-main-window');
  };

  // Tier 2: user accepted a suggestion — send observation context to the webapp
  // and open the main window (a true-positive engage). The bubble fades out
  // immediately so the transition into the full chat feels intentional.
  const handleHelpMe = async () => {
    if (!bubble) return;
    const current = bubble;
    if (current.invite) {
      const { inviteId } = current.invite;
      // A preview opens in place; starting the session waits for "Chat with
      // Coco". Without one, or if it can't be loaded, this accepts the invite.
      if (current.invite.hasPreview) {
        const res = await window.electron?.ipcRenderer.invoke(
          'get-instant-suggestion',
          { observationId: current.observationId ?? null },
        );
        if (res?.status === 'ready' && res.suggestion) {
          window.electron?.ipcRenderer.sendMessage('session-invite-revealed', {
            inviteId,
          });
          setBubble((b) =>
            b
              ? {
                  ...b,
                  suggestion: res.suggestion,
                  scenario: res.scenario,
                  fadingOut: false,
                }
              : null,
          );
          return;
        }
      }
      window.electron?.ipcRenderer.sendMessage('session-invite-response', {
        inviteId,
        outcome: 'accepted',
      });
      bubblePinnedRef.current = false;
      setBubble(null);
      setMood('idle');
      return;
    }
    const engagedAt = Math.floor(Date.now() / 1000);
    const recordEngagement = (
      suggestion: InstantSuggestion | undefined,
      destination: 'inline' | 'conversation',
    ) => {
      if (!current.observationId) return;
      window.electron?.ipcRenderer.sendMessage('activity-support-engaged', {
        observationId: current.observationId,
        engagedAt,
        suggestion,
        destination,
      });
    };

    // Record the click right away. If the precomputed content is available,
    // the same record is enriched below so History can reopen it verbatim.
    recordEngagement(undefined, 'conversation');

    // Try to reveal the instant suggestion that was precomputed when the bubble
    // appeared. If it's ready, show it in place (no waiting, no chat round-trip).
    const res = await window.electron?.ipcRenderer.invoke('get-instant-suggestion', {
      observationId: current.observationId ?? null,
    });

    if (res?.status === 'ready' && res.suggestion) {
      recordEngagement(res.suggestion, 'inline');
      // Pin the bubble: once the suggestion is revealed it stays until the user
      // closes it with ×. Cancel any pending auto-hide from the Tier-2 phase.
      bubblePinnedRef.current = true;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      setBubble((b) =>
        b
          ? {
              ...b,
              suggestion: res.suggestion,
              scenario: res.scenario,
              fadingOut: false,
            }
          : null,
      );
      return;
    }

    // Fallback: no precomputed suggestion (not ready / failed / no id). Open the
    // chat and inject the observation context as before.
    window.electron?.ipcRenderer.sendMessage('help-me-with-this', {
      phrase: current.phrase,
      label: STATUS_LABEL[current.status] ?? STATUS_LABEL.observing,
      rawObservation: current.rawObservation ?? '',
    });
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setBubble((b) => (b ? { ...b, fadingOut: true } : null));
    fadeTimer.current = setTimeout(() => {
      setBubble(null);
      setMood('idle');
    }, FADE_MS);
  };

  // User explicitly dismissed the suggestion — a negative implicit-feedback
  // label (perceived as intrusive / not useful). Fade out without engaging.
  const handleDismiss = () => {
    if (!bubble) return;
    bubblePinnedRef.current = false;
    if (bubble.invite) {
      window.electron?.ipcRenderer.sendMessage('session-invite-response', {
        inviteId: bubble.invite.inviteId,
        outcome: 'dismissed',
      });
    } else
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setBubble((b) => (b ? { ...b, fadingOut: true } : null));
    fadeTimer.current = setTimeout(() => {
      setBubble(null);
      setMood('idle');
    }, FADE_MS);
  };

  const handleChatAboutSuggestion = (execute = false) => {
    if (!bubble?.suggestion) return;
    const current = bubble;
    window.electron?.ipcRenderer.sendMessage('chat-about-suggestion', {
      execute,
      observationId: current.observationId,
      status: current.status,
      rawObservation: current.rawObservation ?? '',
      suggestion: current.suggestion,
      surface: 'bubble',
      sessionInviteId: current.invite?.inviteId,
    });
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    bubblePinnedRef.current = false;
    setBubble(null);
    setMood('idle');
  };

  // Tier 3: user wants to read the full tutor guidance — open main window.
  const handleViewConversation = () => {
    const target = bubble?.agentReply ?? bubble?.agentWorking;
    if (target) {
      window.electron?.ipcRenderer.sendMessage('view-agent-reply', target);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      bubblePinnedRef.current = false;
      setBubble(null);
      setMood('idle');
    } else window.electron?.ipcRenderer.sendMessage('open-main-window');
  };

  // Menu items chosen in the ••• menu window run here, where the current bubble
  // and Coco's mood live. Refreshed every render so the listener sees both.
  menuActionRef.current = (action: AvatarMenuAction) => {
    if (action === 'open-main-window') handleOpenChat();
    else if (action === 'toggle-sleep')
      setCocoSleepMode(!cocoSleeping).catch(() => undefined);
    else if (action === 'quit')
      window.electron?.ipcRenderer.sendMessage('quit-from-avatar');
    else window.electron?.ipcRenderer.sendMessage(action);
  };

  // Clicks and hovers on the bubble, which is drawn in its own window. Also
  // refreshed every render so handlers see the current bubble.
  bubbleEventRef.current = (type: AvatarBubbleEvent) => {
    if (type === 'help') handleHelpMe();
    else if (type === 'dismiss') handleDismiss();
    else if (type === 'view-conversation') handleViewConversation();
    else if (type === 'chat') handleChatAboutSuggestion();
    else if (type === 'run') handleChatAboutSuggestion(true);
    else if (type === 'enter') handleBubbleEnter();
    else if (type === 'leave') handleBubbleLeave();
  };

  // The bubble window draws whatever bubble is current here.
  useEffect(() => {
    window.electron?.ipcRenderer.sendMessage('avatar-bubble-state', {
      bubble,
    });
  }, [bubble]);

  return (
    <div className="pet-stage">
      {pulse && (
        <span
          key={pulse.key}
          className={`pet-pulse-ring pulse-${pulse.status}`}
          aria-hidden
        />
      )}
      <div
        className={`pet-container${actionsMenuOpen ? ' has-open-actions' : ''}${
          dragging ? ' is-dragging' : ''
        }`}
        onContextMenu={(event) => {
          event.preventDefault();
          openActionsMenu();
        }}
      >
        <PetSprite mood={cocoSleeping && !bubble?.agentReply && !bubble?.agentWorking ? 'sleep' : mood} />
        <span className="pet-drag-hint" aria-hidden>
          Right-click for menu
        </span>

        <button
          type="button"
          className={`pet-actions-trigger${actionsMenuOpen ? ' is-open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            openActionsMenu();
          }}
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={actionsMenuOpen}
        >
          •••
        </button>

      </div>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<PetView />} />
      </Routes>
    </Router>
  );
}
