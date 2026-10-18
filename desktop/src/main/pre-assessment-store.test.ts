import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readPreAssessmentState,
  registerPreAssessmentIpc,
} from './pre-assessment-store';

describe('pre-assessment store', () => {
  let directory: string;
  let userId: string | null;
  let invoke: (name: string, ...args: unknown[]) => Promise<unknown>;
  let completed: jest.Mock;
  let requestJson: jest.Mock;
  let remoteUsers: Record<
    string,
    { sets: Record<'A' | 'E', Record<string, unknown> | null> }
  >;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-pre-assessment-'));
    userId = 'alice';
    completed = jest.fn();
    remoteUsers = {};
    requestJson = jest.fn(async (route, method, body) => {
      const remote = (remoteUsers[userId!] ??= {
        sets: { A: null, E: null },
      });
      if (method === 'GET')
        return {
          complete: Boolean(remote.sets.A && remote.sets.E),
          sets: remote.sets,
        };
      const set = route.endsWith('/A') ? 'A' : 'E';
      if (!remote.sets[set])
        remote.sets[set] = {
          set,
          responses: body.responses,
          score: body.score,
          max_score: body.max_score,
          completed_at: '2026-09-23T00:00:00Z',
        };
      return remote.sets[set];
    });
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerPreAssessmentIpc(
      {
        handle: (name, handler) => {
          handlers.set(name, handler);
        },
      },
      () => directory,
      () => userId,
      () => ({ requestJson }),
      completed,
    );
    invoke = async (name, ...args) => handlers.get(name)!(null, ...args);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('scores both sets locally and unlocks only after both are complete', async () => {
    const setA = await invoke('pre-assessment-submit', 'A', {
      1: 'B',
      2: 'C',
      3: 'B',
      4: 'C',
      5: 'C',
      6: 'B',
      7: 'C',
      8: 'C',
    });
    expect(setA).toMatchObject({ set: 'A', score: 8, maxScore: 8 });
    expect(requestJson).toHaveBeenCalledWith(
      '/api/study/pre-assessments/A',
      'POST',
      expect.objectContaining({ score: 8, max_score: 8 }),
    );
    expect(readPreAssessmentState(directory, userId).complete).toBe(false);

    const setE = await invoke('pre-assessment-submit', 'E', {
      e1: 'I would check state-specific hiring rules, the current federal and state minimum wage, and whether health insurance benefits vary by employer size.',
      e2: 'I would use IRS.gov, DOL.gov, and my state labor department.',
      e3: 'The wage and benefits claims are risky because laws and thresholds can change.',
    });
    expect(setE).toMatchObject({ set: 'E', score: 4, maxScore: 4 });
    expect(readPreAssessmentState(directory, userId).complete).toBe(true);
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it('keeps progress separate for each signed-in participant', async () => {
    await invoke('pre-assessment-submit', 'A', {
      1: 'A',
      2: 'A',
      3: 'A',
      4: 'A',
      5: 'A',
      6: 'A',
      7: 'A',
      8: 'A',
    });
    userId = 'bob';
    expect(await invoke('pre-assessment-state')).toEqual({
      complete: false,
      sets: { A: null, E: null },
    });
  });
});
