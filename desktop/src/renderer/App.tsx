import { useEffect, useRef, useState } from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import ObservationBubble, {
  BubbleState,
} from './components/ObservationBubble';
import PetSprite from './components/PetSprite';
import {
  ActivityRecord,
  InstantSuggestion,
  LANE_LABEL,
  ObservationEvent,
  ObservationStatus,
  PetMood,
  STATUS_LABEL,
  STATUS_TO_MOOD,
  cleanObservation,
  formatClockTime,
  formatDuration,
  laneOf,
  pickPhrase,
} from './components/observation-types';
import {
  DaySummary,
  dailyBuckets,
  dayStartOf,
  summarizeDay,
} from './components/activity-rollup';

// How long the bubble (and the active pet mood) stay up after the latest event.
const HOLD_MS = 20_000;
// Tutor notifications carry real guidance, so keep them visible longer.
const TUTOR_HOLD_MS = 30_000;
// CSS transition for the bubble fade-out.
const FADE_MS = 400;
// After this much silence, the pet drifts to the slow "sleep" pack.
const IDLE_TO_SLEEP_MS = 5 * 60_000;
// Pulse ring is shown for one second per new event.
const PULSE_MS = 1_000;

// Avatar window sizing. The window starts at the base footprint (just the
// pet) and is grown by main.ts whenever the bubble or history panel becomes
// visible, then shrunk back when they go away — keeps the transparent
// overlay from stealing clicks on the rest of the desktop.
const WIN_BASE_W = 180;
const WIN_BASE_H = 180;
const WIN_BUBBLE_W = 420;   // Tier 3 bubble max-width 240 + 168 offset + slack
const WIN_BUBBLE_H = 320;   // bubble (label + wrapped text + action button)
// Revealed instant suggestion shows a scrollable body — taller footprint.
const WIN_SUGGESTION_H = 520;
const WIN_HISTORY_W = 440;  // activity panel ~260 + 168 offset + slack
const WIN_HISTORY_H = 540;  // strip + summary + timeline + counts + feed

/**
 * Statuses that represent mid-friction observations (Tier 2).
 * These show a delayed "Help me with this" button.
 * Positive statuses (progress, observing) are Tier 1 — no button.
 * Tutor guidance arrives via the tutor-notification IPC channel (Tier 3).
 */
const TIER2_STATUSES = new Set<ObservationStatus>([
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'discernment_opportunity',
]);

// ── Activity Panel ─────────────────────────────────────────────────────────
// Hybrid layout: a 14-day contribution strip on top, then the selected day's
// summary + flow timeline, then that day's observation feed. Everything is
// derived from the raw ActivityRecord[] via the pure rollup helpers, so the
// strip, timeline, and counts can never disagree.

function dayHeading(dayStartTs: number, todayStart: number): string {
  if (dayStartTs === todayStart) return 'Today';
  if (dayStartTs === todayStart - 24 * 3600) return 'Yesterday';
  return new Date(dayStartTs * 1000).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatMetricTokens(n?: number): string {
  if (typeof n !== 'number') return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatMetricLatency(ms?: number): string {
  if (typeof ms !== 'number') return '0s';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function LlmMetricChips({ record }: { record: ActivityRecord }) {
  const m = record.llm_metrics;
  if (!m) return null;
  return (
    <div className="obs-history-metrics">
      <span>{formatMetricTokens(m.input_tokens ?? m.prompt_tokens)} in</span>
      <span>{formatMetricTokens(m.output_tokens ?? m.completion_tokens)} out</span>
      <span>{formatMetricLatency(m.duration_ms)}</span>
    </div>
  );
}

function SupportControls({
  record,
  isOpen,
  onToggle,
  onRate,
}: {
  record: ActivityRecord;
  isOpen: boolean;
  onToggle: () => void;
  onRate: (rating: 'up' | 'down') => void;
}) {
  const support = record.proactive_support;
  if (!support) return null;
  const canView = support.suggestion != null || support.available === true;
  return (
    <div className="obs-support-controls">
      {canView && (
        <button
          type="button"
          className="obs-support-view"
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          {isOpen ? 'Hide' : 'View support'}
        </button>
      )}
      {(['up', 'down'] as const).map((rating) => (
        <button
          key={rating}
          type="button"
          className={`obs-support-rating${
            support.rating === rating ? ' is-rated' : ''
          }`}
          aria-label={rating === 'up' ? 'Good suggestion' : 'Not helpful'}
          title={rating === 'up' ? 'Good suggestion' : 'Not helpful'}
          disabled={support.rating != null}
          onClick={() => onRate(rating)}
        >
          {rating === 'up' ? '👍' : '👎'}
        </button>
      ))}
    </div>
  );
}

function HistoricalSupport({
  record,
  onViewConversation,
  loading,
  error,
}: {
  record: ActivityRecord;
  onViewConversation: () => void;
  loading: boolean;
  error: boolean;
}) {
  const support = record.proactive_support;
  if (!support) return null;
  const { suggestion } = support;
  if (loading) {
    return <div className="obs-support-content">Preparing suggestion…</div>;
  }
  if (!suggestion) {
    return (
      <div className="obs-support-content obs-support-content--conversation">
        <p>
          {error
            ? 'The suggestion could not be loaded.'
            : 'This support continued in the conversation.'}
        </p>
        {support.engaged && (
          <button type="button" onClick={onViewConversation}>
            View conversation →
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="obs-support-content">
      <strong>{suggestion.title}</strong>
      <p>
        {suggestion.kind === 'delegate' ? suggestion.prompt : suggestion.body}
      </p>
    </div>
  );
}

function FlowTimeline({ summary }: { summary: DaySummary }) {
  const { segments, windowStartTs, windowEndTs } = summary;
  const winDur = Math.max(1, windowEndTs - windowStartTs);

  if (segments.length === 0) {
    return <div className="obs-timeline obs-timeline--empty">No activity</div>;
  }

  return (
    <div className="obs-timeline">
      <div className="obs-timeline-track">
        {segments.map((seg, i) => {
          const left = ((seg.startTs - windowStartTs) / winDur) * 100;
          const width = ((seg.endTs - seg.startTs) / winDur) * 100;
          return (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className={`obs-timeline-seg obs-lane--${seg.lane}`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }}
              title={`${LANE_LABEL[seg.lane]} · ${formatClockTime(seg.startTs)}`}
            />
          );
        })}
      </div>
      <div className="obs-timeline-axis">
        <span>{formatClockTime(windowStartTs)}</span>
        <span>{formatClockTime(windowEndTs)}</span>
      </div>
    </div>
  );
}

function ActivityPanel({
  records,
  onClose,
  onViewConversation,
  onLoadSuggestion,
  onRateSupport,
}: {
  records: ActivityRecord[];
  onClose: () => void;
  onViewConversation: () => void;
  onLoadSuggestion: (
    record: ActivityRecord,
  ) => Promise<InstantSuggestion | null>;
  onRateSupport: (record: ActivityRecord, rating: 'up' | 'down') => void;
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = dayStartOf(nowSec);
  const [selectedDay, setSelectedDay] = useState(todayStart);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openSupport, setOpenSupport] = useState<Set<number>>(new Set());
  const [loadingSupport, setLoadingSupport] = useState<Set<string>>(new Set());
  const [supportErrors, setSupportErrors] = useState<Set<string>>(new Set());

  const buckets = dailyBuckets(records, 14, nowSec);
  const summary = summarizeDay(records, selectedDay, nowSec);
  const dayEnd = selectedDay + 24 * 3600;
  // Day's observations, newest-first, for the feed.
  const dayRecords = records
    .filter((r) => r.ts >= selectedDay && r.ts < dayEnd)
    .sort((a, b) => b.ts - a.ts);

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function selectDay(ts: number) {
    setSelectedDay(ts);
    setExpanded(new Set());
    setOpenSupport(new Set());
  }

  async function toggleSupport(i: number, record: ActivityRecord) {
    const opening = !openSupport.has(i);
    setOpenSupport((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    if (!opening || record.proactive_support?.suggestion) return;
    const key = record.observation_id ?? `${record.ts}-${i}`;
    setLoadingSupport((prev) => new Set(prev).add(key));
    setSupportErrors((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const suggestion = await onLoadSuggestion(record);
    setLoadingSupport((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (!suggestion) setSupportErrors((prev) => new Set(prev).add(key));
  }

  return (
    <div className="obs-history-panel">
      <div className="obs-history-header">
        <span className="obs-history-title">Activity</span>
        <button
          type="button"
          className="obs-history-close"
          onClick={onClose}
          title="Close"
        >
          ×
        </button>
      </div>

      {/* 14-day contribution strip — fill intensity tracks flow time. */}
      <div className="obs-strip" role="group" aria-label="Last 14 days">
        {buckets.map((b) => (
          <button
            key={b.dayStartTs}
            type="button"
            className={`obs-strip-cell obs-level--${b.level}${
              b.dayStartTs === selectedDay ? ' is-selected' : ''
            }${b.isToday ? ' is-today' : ''}`}
            title={`${dayHeading(b.dayStartTs, todayStart)} · ${formatDuration(
              b.flowSec,
            )} in flow`}
            onClick={() => selectDay(b.dayStartTs)}
          />
        ))}
      </div>

      {/* Selected-day summary. */}
      <div className="obs-summary">
        <span className="obs-summary-day">
          {dayHeading(selectedDay, todayStart)}
        </span>
        <span className="obs-summary-stat">
          {formatDuration(summary.activeSec)} active
        </span>
        <span className="obs-summary-stat obs-lane-text--flow">
          {summary.flowPct}% flow
        </span>
      </div>

      <FlowTimeline summary={summary} />

      <div className="obs-summary-counts">
        <span className="obs-count">
          <i className="obs-dot obs-lane--focus" /> {summary.focusCount} focus
        </span>
        <span className="obs-count">
          <i className="obs-dot obs-lane--assist" /> {summary.assistCount} AI
          assist
        </span>
      </div>

      {/* Day's observation feed. */}
      {dayRecords.length === 0 ? (
        <p className="obs-history-empty">No observations this day.</p>
      ) : (
        <ul className="obs-history-list">
          {dayRecords.map((e, i) => {
            const isOpen = expanded.has(i);
            const lane = laneOf(e.status);
            const label = STATUS_LABEL[e.status] ?? STATUS_LABEL.observing;
            const supportOpen = openSupport.has(i);
            const supportKey = e.observation_id ?? `${e.ts}-${i}`;
            return (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i} className="obs-history-entry">
                <span
                  className={`obs-history-dot obs-lane--${lane}`}
                  title={LANE_LABEL[lane]}
                />
                <div className="obs-history-body">
                  <div className="obs-history-meta">
                    <span className="obs-history-label">{label}</span>
                    <span className="obs-history-time">
                      {formatClockTime(e.ts)}
                    </span>
                  </div>
                  {e.proactive_support &&
                    (e.proactive_support.suggestion ||
                      e.proactive_support.available) && (
                      <div className="obs-support-status">
                        <span>Proactive support</span>
                        <SupportControls
                          record={e}
                          isOpen={supportOpen}
                          onToggle={() => toggleSupport(i, e)}
                          onRate={(rating) => onRateSupport(e, rating)}
                        />
                      </div>
                    )}
                  <LlmMetricChips record={e} />
                  <button
                    type="button"
                    className="obs-history-row"
                    onClick={() => toggle(i)}
                    aria-expanded={isOpen}
                  >
                    <p className={`obs-history-text${isOpen ? ' is-open' : ''}`}>
                      {e.observation}
                    </p>
                    <span
                      className={`obs-history-chevron${isOpen ? ' is-open' : ''}`}
                      aria-hidden
                    >
                      ›
                    </span>
                  </button>
                  {supportOpen && (
                    <HistoricalSupport
                      record={e}
                      onViewConversation={onViewConversation}
                      loading={loadingSupport.has(supportKey)}
                      error={supportErrors.has(supportKey)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Pet View ──────────────────────────────────────────────────────────────────

function PetView() {
  // Start in `dormant` (static sleep1.png, no animation) until the first
  // observation event arrives. After that the state machine takes over and
  // dormant is never re-entered for the lifetime of the window.
  const [mood, setMood] = useState<PetMood>('dormant');
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [pulse, setPulse] = useState<{
    status: ObservationStatus;
    key: number;
  } | null>(null);

  // Persisted activity history (newest-first). Hydrated from the main process
  // on mount, then appended to live as observation events arrive.
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Use refs so listener captures the latest cleanup targets without
  // re-subscribing every render.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        sleepTimer.current = setTimeout(
          () => setMood('sleep'),
          Math.max(IDLE_TO_SLEEP_MS - holdMs, 0),
        );
      }, FADE_MS);
    }, holdMs);
  };

  const handleBubbleEnter = () => {
    bubbleHoverRef.current = true;
    // Cancel any pending hide / in-flight fade and bring it fully back.
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setBubble((b) => (b && b.fadingOut ? { ...b, fadingOut: false } : b));
  };

  const handleBubbleLeave = () => {
    bubbleHoverRef.current = false;
    if (bubblePinnedRef.current) return; // pinned suggestion — never re-arm hide
    if (bubble) scheduleBubbleHide(holdMsRef.current);
  };

  // Cmd/Ctrl+Shift+H toggles the history panel from anywhere on the system.
  useEffect(() => {
    const cleanupToggle = window.electron?.ipcRenderer.on(
      'toggle-observation-history',
      () => setShowHistory((v) => !v),
    );
    const cleanupOpen = window.electron?.ipcRenderer.on(
      'open-observation-history',
      () => setShowHistory(true),
    );
    window.electron?.ipcRenderer.sendMessage('avatar-renderer-ready');
    return () => {
      if (typeof cleanupToggle === 'function') cleanupToggle();
      if (typeof cleanupOpen === 'function') cleanupOpen();
    };
  }, []);

  useEffect(() => {
    window.electron?.ipcRenderer.sendMessage('activity-history-visibility', {
      visible: showHistory,
    });
  }, [showHistory]);

  // Refresh from persisted activity whenever History opens. Engagement is
  // written by the main process after the original observation, so a one-time
  // mount snapshot can otherwise remain stale even though the disk record is
  // correct. The file is chronological; renderer state is newest-first.
  useEffect(() => {
    if (!showHistory) return undefined;
    let cancelled = false;
    window.electron?.ipcRenderer
      .invoke('get-activity-history')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setRecords((rows as ActivityRecord[]).slice().reverse());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showHistory]);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'observation-update',
      (data: any) => {
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
        // Seed phrase choice on the event timestamp so re-renders are stable.
        const seed = Math.floor((event.ts ?? Date.now() / 1000) * 1000);
        const phrase = pickPhrase(incomingStatus, seed);

        // Clear any in-flight timers — we're starting a fresh visible window.
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (sleepTimer.current) clearTimeout(sleepTimer.current);
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
        if (showHelpButton) {
          window.electron?.ipcRenderer.sendMessage('training-feedback', {
            kind: 'shown',
            surface: 'bubble',
            observation_id: event.observation_id ?? null,
            status: incomingStatus,
          });
        }

        // Pulse ring around the pet — incrementing the key restarts the CSS
        // animation even if it's the same status as before.
        pulseKeyRef.current += 1;
        setPulse({ status: incomingStatus, key: pulseKeyRef.current });
        pulseTimer.current = setTimeout(() => setPulse(null), PULSE_MS);

        // After HOLD_MS: fade the bubble out and drop the pet back to idle.
        // (Paused while the pointer is over the bubble.)
        scheduleBubbleHide(HOLD_MS);

        // ── Accumulate activity history ────────────────────────────────────
        // Main has already persisted this event to disk; we mirror it into
        // local state so the open panel updates live without a re-fetch.
        const record: ActivityRecord = {
          status: incomingStatus,
          observation: cleanObservation(event.observation),
          ts: event.ts ?? Math.floor(Date.now() / 1000),
          observation_id: event.observation_id,
          proactive_support: showHelpButton
            ? { engaged: false, available: true }
            : undefined,
          llm_metrics: event.llm_metrics,
        };
        // Prepend so the list is newest-first.
        // Deduplicate: if the most recent record has the same text and
        // status, skip it (handles SSE reconnect replays and server
        // double-emits from the progress detector).
        setRecords((prev) => {
          if (
            prev.length > 0 &&
            prev[0].observation === record.observation &&
            prev[0].status === record.status
          ) {
            return prev;
          }
          return [record, ...prev];
        });
      },
    );

    return () => {
      if (typeof cleanup === 'function') cleanup();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  // ── Tier 3: tutor notification routed from main when webapp is hidden ────────
  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'tutor-notification',
      (data: any) => {
        const message = String((data as { message?: unknown })?.message ?? '');
        if (!message) return;

        // Tier 3 replaces any in-flight observation, including Tier 2.
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (sleepTimer.current) clearTimeout(sleepTimer.current);
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

  // Clicking the pet opens the chat. If a Tier-1 ("progress"/"observing") bubble
  // is showing — i.e. the system offered no proactive suggestion — a pet click
  // is an explicit "I need help anyway": a false-negative signal.
  const handleClick = (e?: React.SyntheticEvent) => {
    e?.stopPropagation?.();
    if (bubble && !bubble.tutorMessage && !bubble.showHelpButton) {
      window.electron?.ipcRenderer.sendMessage('training-feedback', {
        kind: 'need_help',
        surface: 'bubble',
        observation_id: bubble.observationId ?? null,
        status: bubble.status,
        text: bubble.rawObservation ?? null,
      });
    }
    window.electron?.ipcRenderer.sendMessage('open-main-window');
  };

  // Tier 2: user accepted a suggestion — send observation context to the webapp
  // and open the main window (a true-positive engage). The bubble fades out
  // immediately so the transition into the full chat feels intentional.
  const handleHelpMe = async () => {
    if (!bubble) return;
    const current = bubble;
    const engagedAt = Math.floor(Date.now() / 1000);
    const recordEngagement = (
      suggestion: InstantSuggestion | undefined,
      destination: 'inline' | 'conversation',
    ) => {
      if (!current.observationId) return;
      setRecords((prev) =>
        prev.map((record) =>
          record.observation_id === current.observationId
            ? {
                ...record,
                proactive_support: {
                  engaged: true,
                  engaged_at: engagedAt,
                  suggestion,
                  destination,
                },
              }
            : record,
        ),
      );
      window.electron?.ipcRenderer.sendMessage('activity-support-engaged', {
        observationId: current.observationId,
        engagedAt,
        suggestion,
        destination,
      });
    };

    // Reflect the click immediately. If the precomputed content is available,
    // the same record is enriched below so History can reopen it verbatim.
    recordEngagement(undefined, 'conversation');
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: 'engage',
      surface: 'bubble',
      observation_id: current.observationId ?? null,
      status: current.status,
      text: current.rawObservation ?? null,
    });

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
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
      setBubble((b) => (b ? { ...b, suggestion: res.suggestion, fadingOut: false } : null));
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
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: 'dismiss',
      surface: 'bubble',
      observation_id: bubble.observationId ?? null,
      status: bubble.status,
      text: bubble.rawObservation ?? null,
    });
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setBubble((b) => (b ? { ...b, fadingOut: true } : null));
    fadeTimer.current = setTimeout(() => {
      setBubble(null);
      setMood('idle');
    }, FADE_MS);
  };

  // Tier 3: user wants to read the full tutor guidance — open main window.
  const handleViewConversation = () => {
    window.electron?.ipcRenderer.sendMessage('open-main-window');
  };

  const loadHistoricalSuggestion = async (
    record: ActivityRecord,
  ): Promise<InstantSuggestion | null> => {
    let res;
    try {
      res = await window.electron?.ipcRenderer.invoke(
        'get-instant-suggestion',
        {
          observationId: record.observation_id ?? null,
        },
      );
    } catch {
      return null;
    }
    const suggestion = res?.status === 'ready' ? res.suggestion : null;
    if (!suggestion) return null;
    setRecords((prev) =>
      prev.map((item) =>
        item.observation_id === record.observation_id
          ? {
              ...item,
              proactive_support: {
                engaged: item.proactive_support?.engaged ?? false,
                ...item.proactive_support,
                suggestion,
                available: true,
              },
            }
          : item,
      ),
    );
    return suggestion;
  };

  const rateHistoricalSupport = (
    record: ActivityRecord,
    rating: 'up' | 'down',
  ) => {
    if (!record.observation_id || record.proactive_support?.rating) return;
    const ratedAt = Math.floor(Date.now() / 1000);
    setRecords((prev) =>
      prev.map((item) =>
        item.observation_id === record.observation_id
          ? {
              ...item,
              proactive_support: {
                engaged: item.proactive_support?.engaged ?? false,
                ...item.proactive_support,
                rating,
                rated_at: ratedAt,
              },
            }
          : item,
      ),
    );
    window.electron?.ipcRenderer.sendMessage('training-feedback', {
      kind: rating === 'up' ? 'thumbs_up' : 'thumbs_down',
      surface: 'history',
      observation_id: record.observation_id,
      status: record.status,
      text:
        record.proactive_support?.suggestion?.copyText ?? record.observation,
    });
    window.electron?.ipcRenderer.sendMessage('activity-support-rated', {
      observationId: record.observation_id,
      rating,
      ratedAt,
    });
  };

  const bubbleVisible = bubble != null;
  const suggestionVisible = bubble?.suggestion != null;
  const historyVisible = showHistory;

  // Resize the avatar window to fit whatever is currently on stage. Runs on
  // mount (shrinks from any leftover default size to the base footprint) and
  // whenever the bubble or history visibility flips.
  useEffect(() => {
    let width = WIN_BASE_W;
    let height = WIN_BASE_H;
    if (bubbleVisible) {
      width = Math.max(width, WIN_BUBBLE_W);
      height = Math.max(height, suggestionVisible ? WIN_SUGGESTION_H : WIN_BUBBLE_H);
    }
    if (historyVisible) {
      width = Math.max(width, WIN_HISTORY_W);
      height = Math.max(height, WIN_HISTORY_H);
    }
    window.electron?.ipcRenderer.sendMessage('resize-avatar-window', {
      width,
      height,
    });
  }, [bubbleVisible, suggestionVisible, historyVisible]);

  return (
    <div className="pet-stage">
      {/* Activity panel */}
      {showHistory && (
        <ActivityPanel
          records={records}
          onClose={() => setShowHistory(false)}
          onViewConversation={handleViewConversation}
          onLoadSuggestion={loadHistoricalSuggestion}
          onRateSupport={rateHistoricalSupport}
        />
      )}

      <ObservationBubble
        bubble={bubble}
        onHelpMe={handleHelpMe}
        onDismiss={handleDismiss}
        onViewConversation={handleViewConversation}
        onMouseEnter={handleBubbleEnter}
        onMouseLeave={handleBubbleLeave}
      />
      {pulse && (
        <span
          key={pulse.key}
          className={`pet-pulse-ring pulse-${pulse.status}`}
          aria-hidden
        />
      )}
      <div
        className="pet-container"
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick(e);
        }}
        title="Open the chat"
      >
        <PetSprite mood={mood} />
        <button
          type="button"
          className="open-button"
          onClick={handleClick}
          title="Open Main Window"
        >
          ▶
        </button>

        {/* History pill — always visible */}
        <button
          type="button"
          className={`history-btn ${showHistory ? 'is-active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setShowHistory((v) => !v);
          }}
          title="See observation history"
        >
          ⏱ History
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
