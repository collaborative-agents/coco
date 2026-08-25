import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  markLearningRecapsReviewedThrough,
  readLatestUnreviewedLearningDay,
  saveLearningRecap,
} from './learning-recap-store';

describe('learning recap store', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-learning-recap-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns every recap from the latest prior learning day', () => {
    saveLearningRecap(root, {
      sessionId: 'aug-22-session',
      userId: 'participant-1',
      generatedAt: new Date(2026, 7, 22, 16, 0).getTime() / 1000,
      recap: {
        summary_title: 'An older lesson',
        bullets: ['This belongs to an older activity day.'],
      },
    });
    saveLearningRecap(root, {
      sessionId: 'aug-24-morning',
      userId: 'participant-1',
      generatedAt: new Date(2026, 7, 24, 10, 0).getTime() / 1000,
      recap: {
        summary_title: 'Verify AI output before applying it',
        bullets: ['Check important claims against the source.', 'Keep constraints explicit.'],
        quiz: { question: 'Not stored' },
      },
    });
    saveLearningRecap(root, {
      sessionId: 'aug-24-afternoon',
      userId: 'participant-1',
      generatedAt: new Date(2026, 7, 24, 16, 0).getTime() / 1000,
      recap: {
        summary_title: 'Describe the desired outcome',
        bullets: ['State what a successful result should contain.'],
      },
    });

    const recaps = readLatestUnreviewedLearningDay(
      root,
      'participant-1',
      new Date(2026, 7, 26, 0, 0).getTime() / 1000,
    );
    expect(recaps.map((recap) => recap.sessionId)).toEqual([
      'aug-24-morning',
      'aug-24-afternoon',
    ]);
  });

  it('does not return a recap again after it was reviewed', () => {
    const generatedAt = new Date(2026, 7, 24, 16, 0).getTime() / 1000;
    saveLearningRecap(root, {
      sessionId: 'session-1',
      userId: 'participant-1',
      generatedAt,
      recap: { summary_title: 'A lesson', bullets: ['One takeaway'] },
    });
    markLearningRecapsReviewedThrough(
      root,
      'participant-1',
      generatedAt,
      new Date(2026, 7, 26, 9, 0).getTime() / 1000,
    );

    expect(
      readLatestUnreviewedLearningDay(
        root,
        'participant-1',
        new Date(2026, 7, 27, 0, 0).getTime() / 1000,
      ),
    ).toEqual([]);
  });
});
