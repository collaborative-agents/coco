/**
 * Pure rollup helpers for the Activity panel.
 *
 * Observations arrive as discrete timestamped points, but the panel speaks in
 * durations ("1h 48m in flow"). We bridge that by attributing each event's lane
 * to the interval until the next event — capped at MAX_SEGMENT_SEC so a long
 * idle gap reads as "away", not as hours of flow. This is the same trick
 * Activity Monitor uses to turn samples into a continuous timeline.
 *
 * Everything here is pure (now is passed in), so it's trivially testable and
 * never touches Date.now() implicitly.
 */
import {
  ActivityLane,
  ActivityRecord,
  laneOf,
} from './observation-types';

// Gap beyond which we stop attributing time to the previous observation — the
// user is assumed idle/away rather than continuously in that state.
const MAX_SEGMENT_SEC = 5 * 60;

const DAY_SEC = 24 * 3600;

export interface TimelineSegment {
  lane: ActivityLane;
  startTs: number;
  endTs: number;
  observation: string;
}

export interface DaySummary {
  /** Total attributed (non-idle) time. */
  activeSec: number;
  /** Time spent in the flow lane. */
  flowSec: number;
  /** flowSec / activeSec as a 0–100 integer. */
  flowPct: number;
  focusCount: number;
  assistCount: number;
  segments: TimelineSegment[];
  /** Active window bounds for laying out the timeline. */
  windowStartTs: number;
  windowEndTs: number;
}

export interface DayBucket {
  dayStartTs: number;
  /** Single-letter weekday for the strip. */
  label: string;
  flowSec: number;
  /** Contribution-grid intensity, 0 (none) … 4 (lots). */
  level: 0 | 1 | 2 | 3 | 4;
  isToday: boolean;
}

/** Local midnight (unix seconds) for the day containing `ts`. */
export function dayStartOf(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Walk sorted records, attributing each to the span until the next one (capped
 * at MAX_SEGMENT_SEC, and never past `nowSec`). Records are assumed to lie in
 * the window the caller cares about.
 */
export function buildSegments(
  records: ActivityRecord[],
  nowSec: number,
): TimelineSegment[] {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const segments: TimelineSegment[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const rec = sorted[i];
    const next = sorted[i + 1];
    const cap = Math.min(rec.ts + MAX_SEGMENT_SEC, nowSec);
    const end = next ? Math.min(next.ts, cap) : cap;
    segments.push({
      lane: laneOf(rec.status),
      startTs: rec.ts,
      endTs: Math.max(end, rec.ts),
      observation: rec.observation,
    });
  }
  return segments;
}

/** Roll up a single day's records into the numbers the panel header shows. */
export function summarizeDay(
  records: ActivityRecord[],
  dayStartTs: number,
  nowSec: number,
): DaySummary {
  const dayEndTs = dayStartTs + DAY_SEC;
  const inDay = records.filter((r) => r.ts >= dayStartTs && r.ts < dayEndTs);
  const segments = buildSegments(inDay, Math.min(nowSec, dayEndTs));

  let activeSec = 0;
  let flowSec = 0;
  for (const seg of segments) {
    const dur = seg.endTs - seg.startTs;
    activeSec += dur;
    if (seg.lane === 'flow') flowSec += dur;
  }
  const focusCount = inDay.filter((r) => laneOf(r.status) === 'focus').length;
  const assistCount = inDay.filter((r) => laneOf(r.status) === 'assist').length;

  return {
    activeSec,
    flowSec,
    flowPct: activeSec > 0 ? Math.round((flowSec / activeSec) * 100) : 0,
    focusCount,
    assistCount,
    segments,
    windowStartTs: inDay.length ? inDay[0].ts : dayStartTs,
    windowEndTs: segments.length
      ? segments[segments.length - 1].endTs
      : dayStartTs,
  };
}

function flowLevel(flowSec: number): 0 | 1 | 2 | 3 | 4 {
  if (flowSec <= 0) return 0;
  const min = flowSec / 60;
  if (min < 15) return 1;
  if (min < 45) return 2;
  if (min < 90) return 3;
  return 4;
}

const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Build the contribution strip: one bucket per day for the last `days` days,
 * oldest first, ending today. Intensity tracks flow time per day.
 */
export function dailyBuckets(
  records: ActivityRecord[],
  days: number,
  nowSec: number,
): DayBucket[] {
  const todayStart = dayStartOf(nowSec);
  const buckets: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    // Step by calendar day rather than fixed seconds so DST shifts don't drift.
    const d = new Date(todayStart * 1000);
    d.setDate(d.getDate() - i);
    const dayStartTs = Math.floor(d.getTime() / 1000);
    const { flowSec } = summarizeDay(records, dayStartTs, nowSec);
    buckets.push({
      dayStartTs,
      label: WEEKDAY[d.getDay()],
      flowSec,
      level: flowLevel(flowSec),
      isToday: dayStartTs === todayStart,
    });
  }
  return buckets;
}
