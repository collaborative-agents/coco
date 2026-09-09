import fs from 'fs';
import os from 'os';
import path from 'path';

import { DailyMemoryDraftService } from './daily-memory-drafts';
import { PersonalizationCenterService } from './personalization-center';

function writeFixture(root: string, stateRoot: string) {
  const draftDir = path.join(root, 'memory_drafts', 'draft-1');
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(
    path.join(draftDir, 'memory_draft.json'),
    JSON.stringify({
      draft_id: 'draft-1',
      created_at: 200,
      source_run_id: 'desktop:period-100',
      bullets: [
        {
          id: 'keep-me',
          section: 'when_to_support',
          content: 'Offer help with reports.',
          confidence: 0.9,
        },
        {
          id: 'edit-me',
          section: 'when_to_stay_silent',
          content: 'Never interrupt focused work.',
          confidence: 0.8,
        },
      ],
      metrics: {
        period_end: 100,
        examples_by_preference_id: {
          'keep-me': ['The report was reformatted repeatedly.'],
        },
      },
    }),
  );

  const runDir = path.join(stateRoot, 'runs', 'period-100');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, 'evolve_checkpoint.json'),
    JSON.stringify({
      active_run: { run_id: 'period-100', run_dir: runDir, status: 'running' },
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'resume_state.json'),
    JSON.stringify({
      status: 'running',
      memory: {
        bullets: {
          'm-001': {
            id: 'm-001',
            section: 'how_to_support',
            content: 'Start with a concise explanation.',
            helpful: 2,
            harmful: 0,
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'progress.jsonl'),
    `${JSON.stringify({ epoch: 1, batch: 1, ops_applied: 1, n_bullets: 1 })}\n`,
  );
}

describe('PersonalizationCenterService', () => {
  let root: string;
  let stateRoot: string;
  let center: PersonalizationCenterService;

  beforeEach(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'coco-personalization-center-'),
    );
    stateRoot = path.join(root, 'personalization');
    writeFixture(root, stateRoot);
    const drafts = new DailyMemoryDraftService(root, stateRoot);
    center = new PersonalizationCenterService(stateRoot, drafts);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('exposes checkpoint activity and provisional preferences', () => {
    const snapshot = center.snapshot();

    expect(snapshot.provisional).toEqual([
      expect.objectContaining({
        id: 'm-001',
        content: 'Start with a concise explanation.',
      }),
    ]);
    expect(snapshot.activity[0]).toEqual(
      expect.objectContaining({
        title: 'Checkpointed batch 1',
        detail: expect.stringContaining('1 preference change'),
      }),
    );
    expect(snapshot.review?.draft.bullets).toHaveLength(2);
  });

  it('persists review progress and applies kept or edited preferences', () => {
    center.saveDecision({
      draftId: 'draft-1',
      bulletId: 'keep-me',
      decision: 'keep',
    });
    expect(() => center.applyReview('draft-1')).toThrow(
      'Review every preference',
    );

    const saved = center.saveDecision({
      draftId: 'draft-1',
      bulletId: 'edit-me',
      decision: 'edit',
      editedContent: 'Stay quiet during focused reading.',
    });
    expect(saved.review?.decisions['keep-me'].decision).toBe('keep');
    expect(saved.review?.decisions['edit-me'].editedContent).toBe(
      'Stay quiet during focused reading.',
    );

    const applied = center.applyReview('draft-1');
    expect(applied.memory).toContain('Offer help with reports.');
    expect(applied.memory).toContain('Stay quiet during focused reading.');
    expect(applied.memory).not.toContain('Never interrupt focused work.');
    expect(center.snapshot().review).toBeNull();
    expect(center.snapshot().history[0].draftId).toBe('draft-1');
  });
});
