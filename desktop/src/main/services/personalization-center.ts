import fs from 'fs';
import path from 'path';

import {
  DailyMemoryDraftService,
  type DailyMemoryDraft,
} from './daily-memory-drafts';

export type ReviewDecision = 'keep' | 'reject' | 'edit';

interface SavedDecision {
  decision: ReviewDecision;
  editedContent?: string;
  decidedAt: number;
}

interface ReviewProgressFile {
  drafts?: Record<
    string,
    {
      decisions?: Record<string, SavedDecision>;
      updatedAt?: number;
    }
  >;
}

interface MemoryBulletState {
  id?: string;
  section?: string;
  content?: string;
  helpful?: number;
  harmful?: number;
  updated_at?: number;
}

interface ResumeState {
  status?: string;
  memory?: {
    bullets?: Record<string, MemoryBulletState>;
  };
}

interface EvolveCheckpoint {
  active_run?: {
    run_id?: string;
    run_dir?: string;
    status?: string;
  };
}

export interface PersonalizationCenterSnapshot {
  provisional: Array<{
    id: string;
    section: string;
    content: string;
    helpful: number;
    harmful: number;
    updatedAt?: number;
  }>;
  activity: Array<{
    id: string;
    kind: 'batch' | 'skipped' | 'epoch';
    title: string;
    detail: string;
  }>;
  review: {
    draft: DailyMemoryDraft;
    decisions: Record<string, SavedDecision>;
  } | null;
  history: Array<{
    draftId: string;
    approvedAt: number;
    periodEnd: number;
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

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return value && typeof value === 'object' && !Array.isArray(value)
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function activityFromProgress(
  rows: Array<Record<string, unknown>>,
): PersonalizationCenterSnapshot['activity'] {
  return rows
    .slice(-20)
    .reverse()
    .map((row, index) => {
      if (row.event === 'batch_skipped') {
        return {
          id: `skipped-${String(row.epoch)}-${String(row.batch)}-${index}`,
          kind: 'skipped',
          title: `Batch ${String(row.batch)} needs attention`,
          detail: `${String(row.moment_count ?? 0)} moments were skipped after a temporary model error.`,
        };
      }
      if (row.event === 'epoch_end') {
        const utility = Number(row.measured_utility);
        return {
          id: `epoch-${String(row.epoch)}-${index}`,
          kind: 'epoch',
          title: `Learning pass ${String(row.epoch)} completed`,
          detail: Number.isFinite(utility)
            ? `Measured utility ${Math.round(utility * 100)}%.`
            : 'The pass was checkpointed successfully.',
        };
      }
      const operations = Number(row.ops_applied ?? 0);
      return {
        id: `batch-${String(row.epoch)}-${String(row.batch)}-${index}`,
        kind: 'batch',
        title: `Checkpointed batch ${String(row.batch)}`,
        detail: `${operations} ${operations === 1 ? 'preference change' : 'preference changes'} saved at this checkpoint.`,
      };
    });
}

export class PersonalizationCenterService {
  private readonly reviewProgressPath: string;

  private readonly dailyReviewStatePath: string;

  constructor(
    private readonly stateRoot: string,
    private readonly draftService: DailyMemoryDraftService,
  ) {
    this.reviewProgressPath = path.join(
      stateRoot,
      'personalization_review_progress.json',
    );
    this.dailyReviewStatePath = path.join(
      stateRoot,
      'daily_memory_review.json',
    );
  }

  snapshot(): PersonalizationCenterSnapshot {
    const evolve = readJson<EvolveCheckpoint>(
      path.join(this.stateRoot, 'evolve_checkpoint.json'),
      {},
    );
    const runDir = evolve.active_run?.run_dir;
    const resume = runDir
      ? readJson<ResumeState>(path.join(runDir, 'resume_state.json'), {})
      : {};
    const bullets = resume.memory?.bullets ?? {};
    const provisional = Object.entries(bullets)
      .map(([key, bullet]) => ({
        id: String(bullet.id ?? key),
        section: String(bullet.section ?? 'general'),
        content: String(bullet.content ?? '').trim(),
        helpful: Number(bullet.helpful ?? 0),
        harmful: Number(bullet.harmful ?? 0),
        ...(Number.isFinite(Number(bullet.updated_at)) && {
          updatedAt: Number(bullet.updated_at),
        }),
      }))
      .filter((bullet) => bullet.content)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const activity = runDir
      ? activityFromProgress(readJsonLines(path.join(runDir, 'progress.jsonl')))
      : [];
    const draft = this.draftService.latestPending();
    const progress = readJson<ReviewProgressFile>(this.reviewProgressPath, {});
    const dailyState = readJson<{
      approved?: Record<string, { approvedAt: number; periodEnd: number }>;
    }>(this.dailyReviewStatePath, {});
    const history = Object.entries(dailyState.approved ?? {})
      .map(([draftId, item]) => ({ draftId, ...item }))
      .sort((left, right) => right.approvedAt - left.approvedAt);
    return {
      provisional,
      activity,
      review: draft
        ? {
            draft,
            decisions: progress.drafts?.[draft.draftId]?.decisions ?? {},
          }
        : null,
      history,
    };
  }

  saveDecision(input: {
    draftId: string;
    bulletId: string;
    decision: ReviewDecision;
    editedContent?: string;
  }): PersonalizationCenterSnapshot {
    if (!['keep', 'reject', 'edit'].includes(input.decision)) {
      throw new Error('Review decision is invalid.');
    }
    const draft = this.requirePendingDraft(input.draftId);
    if (!draft.bullets.some((bullet) => bullet.id === input.bulletId)) {
      throw new Error('Preference is no longer part of this draft.');
    }
    const editedContent = input.editedContent?.trim();
    if (input.decision === 'edit' && !editedContent) {
      throw new Error('Edited preference cannot be empty.');
    }
    const progress = readJson<ReviewProgressFile>(this.reviewProgressPath, {});
    const currentDraft = progress.drafts?.[input.draftId] ?? {};
    progress.drafts = {
      ...(progress.drafts ?? {}),
      [input.draftId]: {
        decisions: {
          ...(currentDraft.decisions ?? {}),
          [input.bulletId]: {
            decision: input.decision,
            ...(input.decision === 'edit' && { editedContent }),
            decidedAt: Date.now(),
          },
        },
        updatedAt: Date.now(),
      },
    };
    writeJsonAtomic(this.reviewProgressPath, progress);
    return this.snapshot();
  }

  applyReview(draftId: string): { memory: string; draft: DailyMemoryDraft } {
    const draft = this.requirePendingDraft(draftId);
    const progress = readJson<ReviewProgressFile>(this.reviewProgressPath, {});
    const decisions = progress.drafts?.[draftId]?.decisions ?? {};
    const missing = draft.bullets.filter((bullet) => !decisions[bullet.id]);
    if (missing.length > 0) {
      throw new Error('Review every preference before applying this update.');
    }
    const reviewedBullets = draft.bullets.flatMap((bullet) => {
      const saved = decisions[bullet.id];
      if (saved.decision === 'reject') return [];
      if (saved.decision === 'edit') {
        return [{ ...bullet, content: saved.editedContent!.trim() }];
      }
      return [bullet];
    });
    return this.draftService.approve(draftId, reviewedBullets);
  }

  private requirePendingDraft(draftId: string): DailyMemoryDraft {
    const draft = this.draftService.latestPending();
    if (!draft || draft.draftId !== draftId) {
      throw new Error('Personalization draft is no longer available.');
    }
    return draft;
  }
}
