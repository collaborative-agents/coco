import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DailyMemoryDraftService,
  renderEvolvedMemory,
} from './daily-memory-drafts';

function writeDraft(
  root: string,
  draftId: string,
  periodEnd: number,
  content: string,
) {
  const directory = path.join(root, 'memory_drafts', draftId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'memory_draft.json'),
    JSON.stringify({
      draft_id: draftId,
      created_at: periodEnd + 60,
      source_run_id: `desktop:period-${periodEnd}`,
      bullets: [
        {
          id: `${draftId}:1`,
          section: 'when_to_support',
          content,
          confidence: 0.9,
        },
      ],
      metrics: {
        period_end: periodEnd,
        examples_by_preference_id: {
          [`${draftId}:1`]: [`Example for ${content}`],
        },
      },
    }),
  );
}

describe('DailyMemoryDraftService', () => {
  let root: string;
  let stateRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-daily-memory-'));
    stateRoot = path.join(root, 'personalization');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('offers the newest previous-day draft only once per local day', () => {
    const today = new Date(2026, 7, 17, 9, 0, 0);
    const dayStart = new Date(2026, 7, 17).getTime() / 1000;
    writeDraft(root, 'older', dayStart - 7200, 'Older preference');
    writeDraft(root, 'newest', dayStart - 60, 'Newest preference');
    writeDraft(root, 'today', dayStart + 60, 'Current-day preference');
    const service = new DailyMemoryDraftService(root, stateRoot);

    expect(service.claimForToday(today.getTime())?.draftId).toBe('newest');
    expect(service.claimForToday(today.getTime())).toBeNull();
    expect(
      service.claimForToday(new Date(2026, 7, 18, 9, 0, 0).getTime())?.draftId,
    ).toBe('today');
  });

  it('stores approved model memory separately from user-written memory', () => {
    const dayStart = new Date(2026, 7, 17).getTime() / 1000;
    writeDraft(root, 'first', dayStart - 120, 'Offer help with reports');
    const service = new DailyMemoryDraftService(root, stateRoot);
    const draft = service.claimForToday(new Date(2026, 7, 17, 9).getTime());
    expect(draft).not.toBeNull();
    fs.writeFileSync(path.join(root, 'coco-memory.txt'), 'User-written note\n');

    const first = service.approve(draft!.draftId);
    expect(first.memory).toContain('Offer help with reports');
    expect(first.memory).toContain('Supporting examples:');
    expect(first.memory).toContain('Example for Offer help with reports');
    expect(fs.readFileSync(path.join(root, 'coco-memory.txt'), 'utf8')).toBe(
      'User-written note\n',
    );
    expect(
      fs.readFileSync(path.join(stateRoot, 'evolved-memory.md'), 'utf8'),
    ).toBe(first.memory);

    const replacement = {
      ...draft!,
      draftId: 'replacement',
      bullets: [{ ...draft!.bullets[0], content: 'Stay quiet during reports' }],
    };
    const rendered = renderEvolvedMemory(replacement);
    expect(rendered).toContain('Stay quiet during reports');
    expect(rendered).not.toContain('\n- Offer help with reports');
    expect(
      service.claimForToday(new Date(2026, 7, 18, 9).getTime()),
    ).toBeNull();
  });

  it('keeps earlier approved preferences and manual edits across reviews', () => {
    writeDraft(root, 'first', 100, 'Offer help with reports');
    writeDraft(root, 'second', 200, 'Use concise explanations');
    const service = new DailyMemoryDraftService(root, stateRoot);
    const first = service.approve('first');
    const file = path.join(stateRoot, 'evolved-memory.md');
    fs.appendFileSync(file, '\nMy manually edited preference.\n');
    const second = service.approve('second');
    expect(second.memory).toContain(first.memory.trim());
    expect(second.memory).toContain('My manually edited preference.');
    expect(second.memory).toContain('Use concise explanations');
    expect(service.approve('second').memory).toBe(second.memory);
    expect(fs.readFileSync(file, 'utf8')).toBe(second.memory);
  });

  it('preserves memory when all new preferences are rejected', () => {
    writeDraft(root, 'first', 100, 'Existing preference');
    writeDraft(root, 'rejected', 200, 'Unwanted preference');
    const service = new DailyMemoryDraftService(root, stateRoot);
    const first = service.approve('first');
    expect(service.approve('rejected', []).memory).toBe(first.memory);
    expect(service.latestPending()).toBeNull();
  });

  it('does not duplicate preferences repeated by later drafts', () => {
    writeDraft(root, 'first', 100, 'Offer help with reports');
    writeDraft(root, 'repeat', 200, 'Offer help with reports');
    const service = new DailyMemoryDraftService(root, stateRoot);
    const first = service.approve('first');
    expect(service.approve('repeat').memory).toBe(first.memory);
  });

  it('previews inferred insights from a development Coco-PE state fixture', () => {
    const fixturePath = path.join(
      root,
      'coco-pe-last-4-days',
      'memory_state.json',
    );
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        inferred: {
          insights: [
            {
              section: 'when_to_stay_silent',
              content: 'Stay silent while the user reviews experiment logs.',
              example_bullet_ids: ['m-1'],
            },
          ],
        },
        bullets: {
          'm-1': {
            content:
              'The user reviewed completed job logs without requesting help.',
          },
        },
      }),
    );
    const service = new DailyMemoryDraftService(root, stateRoot, {
      fixtureStatePath: fixturePath,
    });

    const draft = service.claimForToday();

    expect(draft?.summary).toContain('coco-pe-last-4-days');
    expect(draft?.bullets).toEqual([
      expect.objectContaining({
        section: 'when_to_stay_silent',
        content: 'Stay silent while the user reviews experiment logs.',
        examples: [
          'The user reviewed completed job logs without requesting help.',
        ],
      }),
    ]);
    expect(renderEvolvedMemory(draft!)).toContain(
      'The user reviewed completed job logs without requesting help.',
    );
  });
});
