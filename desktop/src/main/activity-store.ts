/**
 * Persistent activity history for the avatar's Activity panel.
 *
 * Every observation event the sensing server emits is teed here as one JSONL
 * line in userData. This is what makes the panel cross-session (Activity
 * Monitor / GitHub-contributions style) instead of losing everything when the
 * avatar window reloads. Records are intentionally minimal — the renderer
 * derives all rollups (flow time, focus moments, daily intensity) on read.
 */
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import log from 'electron-log';
import type {
  ActivityRecord,
  InstantSuggestion,
  ObservationStatus,
} from '../renderer/components/observation-types';

// Only these statuses belong on the activity timeline. task_suggested /
// task_complete drive the notification flow, not the panel, so they're dropped.
const TRACKED_STATUSES = new Set<ObservationStatus>([
  'progress',
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'observing',
  'discernment_opportunity',
]);

// Drop anything older than this on startup so the file can't grow without bound.
const RETENTION_DAYS = 30;

function historyPath(): string {
  return path.join(app.getPath('userData'), 'activity-history.jsonl');
}

/** Append a single observation to the on-disk history. Best-effort. */
export function appendActivity(record: ActivityRecord): void {
  if (!TRACKED_STATUSES.has(record.status)) return;
  try {
    fs.appendFileSync(historyPath(), `${JSON.stringify(record)}\n`);
  } catch (err) {
    log.warn('[activity-store] append failed:', err);
  }
}

/**
 * Read history, newest-first capped by `since` (unix seconds). Malformed lines
 * are skipped rather than throwing — a truncated last line from a crash mid-
 * write should not lose the rest of the day.
 */
export function readActivity(sinceTs = 0): ActivityRecord[] {
  const file = historyPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // No file yet — first run.
  }
  const out: ActivityRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ActivityRecord;
      if (
        typeof rec.ts === 'number' &&
        typeof rec.status === 'string' &&
        rec.ts >= sinceTs
      ) {
        out.push(rec);
      }
    } catch {
      // Skip a corrupt/partial line.
    }
  }
  return out;
}

function writeActivity(records: ActivityRecord[], operation: string): void {
  try {
    fs.writeFileSync(
      historyPath(),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  } catch (err) {
    log.warn(`[activity-store] ${operation} failed:`, err);
  }
}

function updateLatestSupport(
  observationId: string,
  patch: Partial<NonNullable<ActivityRecord['proactive_support']>>,
  operation: string,
): void {
  if (!observationId) return;
  const records = readActivity();
  const reverseIndex = [...records]
    .reverse()
    .findIndex((record) => record.observation_id === observationId);
  if (reverseIndex < 0) return;
  const index = records.length - reverseIndex - 1;
  records[index] = {
    ...records[index],
    proactive_support: {
      engaged: records[index].proactive_support?.engaged ?? false,
      ...records[index].proactive_support,
      ...patch,
    },
  };
  writeActivity(records, operation);
}

/**
 * Mark previously offered support as engaged and optionally persist the inline
 * content. Rewriting is acceptable here: this runs only on an explicit click
 * and the history file is capped to 30 days.
 */
export function recordSupportEngagement(
  observationId: string,
  engagement: {
    engagedAt: number;
    suggestion?: InstantSuggestion;
    destination: 'inline' | 'conversation';
  },
): void {
  if (!observationId) return;
  const records = readActivity();
  const reverseIndex = [...records]
    .reverse()
    .findIndex((record) => record.observation_id === observationId);
  if (reverseIndex < 0) return;
  const index = records.length - reverseIndex - 1;

  records[index] = {
    ...records[index],
    proactive_support: {
      ...records[index].proactive_support,
      engaged: true,
      engaged_at: engagement.engagedAt,
      suggestion:
        engagement.suggestion ?? records[index].proactive_support?.suggestion,
      destination: engagement.destination,
    },
  };
  writeActivity(records, 'support engagement update');
}

/** Persist eager/on-demand support content even if the user never engaged. */
export function recordSupportSuggestion(
  observationId: string,
  suggestion: InstantSuggestion,
): void {
  updateLatestSupport(
    observationId,
    {
      suggestion,
    },
    'support suggestion update',
  );
}

/** Persist a usefulness rating so History reflects feedback across restarts. */
export function recordSupportRating(
  observationId: string,
  rating: 'up' | 'down',
  ratedAt: number,
): void {
  updateLatestSupport(
    observationId,
    {
      rating,
      rated_at: ratedAt,
    },
    'support rating update',
  );
}

/**
 * Rewrite the file dropping records older than RETENTION_DAYS. Runs once at
 * launch; cheap relative to a session and keeps the JSONL bounded.
 */
export function pruneActivity(nowSec: number): void {
  const cutoff = nowSec - RETENTION_DAYS * 24 * 3600;
  const kept = readActivity(cutoff);
  try {
    fs.writeFileSync(
      historyPath(),
      kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''),
    );
  } catch (err) {
    log.warn('[activity-store] prune failed:', err);
  }
}
