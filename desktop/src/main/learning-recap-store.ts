import fs from 'fs';
import path from 'path';
import log from 'electron-log';

export interface StoredLearningRecap {
  sessionId: string;
  userId: string;
  generatedAt: number;
  summaryTitle: string;
  bullets: string[];
  reviewedAt?: number;
}

function storePath(userDataPath: string): string {
  return path.join(userDataPath, 'learning-recaps.json');
}

function isStoredRecap(value: unknown): value is StoredLearningRecap {
  if (!value || typeof value !== 'object') return false;
  const recap = value as Partial<StoredLearningRecap>;
  return (
    typeof recap.sessionId === 'string' &&
    typeof recap.userId === 'string' &&
    typeof recap.generatedAt === 'number' &&
    typeof recap.summaryTitle === 'string' &&
    Array.isArray(recap.bullets) &&
    recap.bullets.every((bullet) => typeof bullet === 'string')
  );
}

function readAll(userDataPath: string): StoredLearningRecap[] {
  try {
    const value = JSON.parse(
      fs.readFileSync(storePath(userDataPath), 'utf8'),
    ) as unknown;
    return Array.isArray(value) ? value.filter(isStoredRecap) : [];
  } catch {
    return [];
  }
}

function writeAll(userDataPath: string, recaps: StoredLearningRecap[]): void {
  const destination = storePath(userDataPath);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify(recaps, null, 2)}\n`,
      'utf8',
    );
    fs.renameSync(temporary, destination);
  } catch (error) {
    log.warn(`[learning-recap-store] write failed: ${String(error)}`);
  }
}

/** Save the learning portion of a generated session recap, excluding its quiz. */
export function saveLearningRecap(
  userDataPath: string,
  input: {
    sessionId: string;
    userId: string;
    generatedAt: number;
    recap: unknown;
  },
): boolean {
  if (!input.recap || typeof input.recap !== 'object') return false;
  const value = input.recap as {
    summary_title?: unknown;
    bullets?: unknown;
  };
  if (
    typeof value.summary_title !== 'string' ||
    !value.summary_title.trim() ||
    !Array.isArray(value.bullets)
  ) {
    return false;
  }
  const bullets = value.bullets
    .filter((bullet): bullet is string => typeof bullet === 'string')
    .map((bullet) => bullet.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (bullets.length === 0) return false;

  const recaps = readAll(userDataPath);
  const previous = recaps.find(
    (recap) =>
      recap.sessionId === input.sessionId && recap.userId === input.userId,
  );
  const next: StoredLearningRecap = {
    sessionId: input.sessionId,
    userId: input.userId,
    generatedAt: input.generatedAt,
    summaryTitle: value.summary_title.trim(),
    bullets,
    ...(previous?.reviewedAt ? { reviewedAt: previous.reviewedAt } : {}),
  };
  writeAll(userDataPath, [
    ...recaps.filter(
      (recap) =>
        recap.sessionId !== input.sessionId || recap.userId !== input.userId,
    ),
    next,
  ]);
  return true;
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** All unreviewed session recaps from the latest earlier learning day. */
export function readLatestUnreviewedLearningDay(
  userDataPath: string,
  userId: string,
  beforeTs: number,
): StoredLearningRecap[] {
  const candidates = readAll(userDataPath)
    .filter(
      (recap) =>
        recap.userId === userId &&
        recap.generatedAt < beforeTs &&
        recap.reviewedAt === undefined,
    )
    .sort((left, right) => left.generatedAt - right.generatedAt);
  const latest = candidates[candidates.length - 1];
  if (!latest) return [];
  const latestDate = localDateKey(latest.generatedAt);
  return candidates.filter(
    (recap) => localDateKey(recap.generatedAt) === latestDate,
  );
}

/** Mark this recap and any older ones as consumed by the next-use review. */
export function markLearningRecapsReviewedThrough(
  userDataPath: string,
  userId: string,
  throughTs: number,
  reviewedAt: number,
): void {
  const recaps = readAll(userDataPath);
  writeAll(
    userDataPath,
    recaps.map((recap) =>
      recap.userId === userId && recap.generatedAt <= throughTs
        ? { ...recap, reviewedAt: recap.reviewedAt ?? reviewedAt }
        : recap,
    ),
  );
}
