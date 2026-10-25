import { useState } from 'react';
import {
  ActivityRecord,
  InstantSuggestion,
  LANE_LABEL,
  STATUS_LABEL,
  formatClockTime,
  formatDuration,
  laneOf,
} from './observation-types';
import {
  DaySummary,
  dailyBuckets,
  dayStartOf,
  summarizeDay,
} from './activity-rollup';
import RatingButtons from './RatingButtons';

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
      <span>
        {formatMetricTokens(m.output_tokens ?? m.completion_tokens)} out
      </span>
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
  const ratingLabels = { up: 'Good suggestion', down: 'Not helpful' };
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
      <RatingButtons
        value={support.rating}
        onRate={onRate}
        labels={ratingLabels}
        className="coco-rating--compact"
      />
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

export default function ActivityPanel({
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
            aria-label={`${dayHeading(b.dayStartTs, todayStart)}, ${formatDuration(
              b.flowSec,
            )} in flow`}
            aria-pressed={b.dayStartTs === selectedDay}
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
                    <p
                      className={`obs-history-text${isOpen ? ' is-open' : ''}`}
                    >
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
