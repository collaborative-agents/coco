import fs from 'fs';
import path from 'path';

const REVIEW_STATE_FILE = 'daily_memory_review.json';
const EVOLVED_MEMORY_FILE = 'evolved-memory.md';

interface DraftBullet {
  id?: string;
  section?: string;
  content?: string;
  confidence?: number;
}

interface DraftFile {
  draft_id?: string;
  created_at?: number;
  source_run_id?: string;
  summary?: string;
  metrics?: {
    period_start?: number;
    period_end?: number;
    examples_by_preference_id?: Record<string, string[]>;
  };
  bullets?: DraftBullet[];
}

interface CocoPeFixtureState {
  bullets?: Record<
    string,
    {
      content?: string;
    }
  >;
  inferred?: {
    insights?: Array<{
      section?: string;
      content?: string;
      example_bullet_ids?: string[];
    }>;
  };
}

interface ReviewState {
  prompted?: Record<string, string>;
  approved?: Record<string, { approvedAt: number; periodEnd: number }>;
  latestApprovedPeriodEnd?: number;
}

export interface DailyMemoryDraft {
  draftId: string;
  createdAt: number;
  periodStart?: number;
  periodEnd: number;
  summary: string;
  bullets: Array<{
    id: string;
    section: string;
    content: string;
    confidence: number;
    examples: string[];
  }>;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function localDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDayStartSeconds(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}

function periodEndOf(draft: DraftFile): number | null {
  const metric = Number(draft.metrics?.period_end);
  if (Number.isFinite(metric) && metric > 0) return metric;
  const match = String(draft.source_run_id ?? '').match(
    /period-(\d+(?:\.\d+)?)$/,
  );
  if (match) return Number(match[1]);
  const createdAt = Number(draft.created_at);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null;
}

function normalizeDraft(raw: DraftFile): DailyMemoryDraft | null {
  const draftId = String(raw.draft_id ?? '').trim();
  const periodEnd = periodEndOf(raw);
  if (!draftId || periodEnd === null) return null;
  const bullets = (raw.bullets ?? [])
    .map((bullet, index) => {
      const id = String(bullet.id ?? `${draftId}:${index}`);
      return {
        id,
        section: String(bullet.section ?? 'general'),
        content: String(bullet.content ?? '').trim(),
        confidence: Number.isFinite(Number(bullet.confidence))
          ? Number(bullet.confidence)
          : 0,
        examples: (raw.metrics?.examples_by_preference_id?.[id] ?? [])
          .map((example) => String(example).trim())
          .filter(Boolean),
      };
    })
    .filter((bullet) => bullet.content.length > 0);
  if (bullets.length === 0) return null;
  const periodStart = Number(raw.metrics?.period_start);
  return {
    draftId,
    createdAt: Number(raw.created_at) || periodEnd,
    periodStart:
      Number.isFinite(periodStart) && periodStart > 0 ? periodStart : undefined,
    periodEnd,
    summary: String(raw.summary ?? ''),
    bullets,
  };
}

export function renderEvolvedMemory(draft: DailyMemoryDraft): string {
  const sectionNames: Record<string, string> = {
    when_to_support: 'When to proactively support',
    when_to_stay_silent: 'When to stay silent',
    how_to_support: 'How to support',
    tool_preferences: 'Tool preferences',
    recurring_tasks: 'Recurring tasks',
    general: 'General',
  };
  const order = Object.keys(sectionNames);
  const sections = [
    ...new Set(draft.bullets.map((bullet) => bullet.section)),
  ].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (
      (leftIndex < 0 ? order.length : leftIndex) -
      (rightIndex < 0 ? order.length : rightIndex)
    );
  });
  const lines = sections.reduce<string[]>(
    (output, section) => {
      output.push(
        '',
        `### ${sectionNames[section] ?? section.replaceAll('_', ' ')}`,
      );
      draft.bullets
        .filter((item) => item.section === section)
        .forEach((bullet) => {
          output.push(`- ${bullet.content}`);
          if (bullet.examples.length > 0) {
            output.push('  - Supporting examples:');
            bullet.examples.forEach((example) =>
              output.push(`    - ${example}`),
            );
          }
        });
      return output;
    },
    ['## Coco learned preferences'],
  );
  return `${lines.join('\n')}\n`;
}

export class DailyMemoryDraftService {
  private readonly draftsRoot: string;

  private readonly evolvedMemoryPath: string;

  private readonly reviewStatePath: string;

  private readonly fixtureStatePath?: string;

  constructor(
    memoryRoot: string,
    personalizationStateRoot: string,
    options: { fixtureStatePath?: string } = {},
  ) {
    this.draftsRoot = path.join(memoryRoot, 'memory_drafts');
    this.evolvedMemoryPath = path.join(
      personalizationStateRoot,
      EVOLVED_MEMORY_FILE,
    );
    this.reviewStatePath = path.join(
      personalizationStateRoot,
      REVIEW_STATE_FILE,
    );
    this.fixtureStatePath = options.fixtureStatePath;
  }

  claimForToday(nowMs = Date.now()): DailyMemoryDraft | null {
    const state = readJson<ReviewState>(this.reviewStatePath, {});
    const today = localDateKey(nowMs);
    if (state.prompted?.[today]) return null;
    const dayStart = localDayStartSeconds(nowMs);
    const approvedThrough = Number(state.latestApprovedPeriodEnd ?? 0);
    const draft = this.readDrafts()
      .filter(
        (item) => item.periodEnd < dayStart && item.periodEnd > approvedThrough,
      )
      .sort(
        (left, right) =>
          right.periodEnd - left.periodEnd || right.createdAt - left.createdAt,
      )[0];
    if (!draft) return null;
    state.prompted = { ...(state.prompted ?? {}), [today]: draft.draftId };
    writeJsonAtomic(this.reviewStatePath, state);
    return draft;
  }

  approve(
    draftId: string,
    nowMs = Date.now(),
  ): {
    memory: string;
    draft: DailyMemoryDraft;
  } {
    const draft = this.readDrafts().find((item) => item.draftId === draftId);
    if (!draft) throw new Error('Memory draft no longer exists.');
    const memory = renderEvolvedMemory(draft);
    fs.mkdirSync(path.dirname(this.evolvedMemoryPath), { recursive: true });
    const temporary = `${this.evolvedMemoryPath}.tmp`;
    fs.writeFileSync(temporary, memory, 'utf8');
    fs.renameSync(temporary, this.evolvedMemoryPath);

    const state = readJson<ReviewState>(this.reviewStatePath, {});
    state.approved = {
      ...(state.approved ?? {}),
      [draft.draftId]: { approvedAt: nowMs / 1000, periodEnd: draft.periodEnd },
    };
    state.latestApprovedPeriodEnd = Math.max(
      Number(state.latestApprovedPeriodEnd ?? 0),
      draft.periodEnd,
    );
    writeJsonAtomic(this.reviewStatePath, state);
    return { memory, draft };
  }

  private readDrafts(): DailyMemoryDraft[] {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.draftsRoot, { withFileTypes: true });
    } catch {
      return this.readFixtureDrafts();
    }
    return [
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          normalizeDraft(
            readJson<DraftFile>(
              path.join(this.draftsRoot, entry.name, 'memory_draft.json'),
              {},
            ),
          ),
        )
        .filter((draft): draft is DailyMemoryDraft => draft !== null),
      ...this.readFixtureDrafts(),
    ];
  }

  private readFixtureDrafts(): DailyMemoryDraft[] {
    if (!this.fixtureStatePath) return [];
    const state = readJson<CocoPeFixtureState>(this.fixtureStatePath, {});
    const insights = (state.inferred?.insights ?? [])
      .map((insight, index) => ({
        id: `fixture-insight-${index + 1}`,
        section: String(insight.section ?? 'general'),
        content: String(insight.content ?? '').trim(),
        confidence: 0.8,
        examples: (insight.example_bullet_ids ?? [])
          .map((bulletId) => state.bullets?.[bulletId]?.content?.trim() ?? '')
          .filter(Boolean),
      }))
      .filter((insight) => insight.content.length > 0);
    if (insights.length === 0) return [];
    let modifiedAt = Date.now();
    try {
      modifiedAt = fs.statSync(this.fixtureStatePath).mtimeMs;
    } catch {
      // The parsed fixture is still useful if its stat disappears mid-read.
    }
    return [
      {
        draftId: `fixture:${path.basename(path.dirname(this.fixtureStatePath))}:${Math.floor(modifiedAt)}`,
        createdAt: modifiedAt / 1000,
        // Development fixtures always represent a completed prior-day period.
        periodEnd: Date.now() / 1000 - 24 * 60 * 60,
        summary: `Development preview from ${path.basename(path.dirname(this.fixtureStatePath))}`,
        bullets: insights,
      },
    ];
  }
}
