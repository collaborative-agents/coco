import fs from 'fs';
import os from 'os';
import path from 'path';
import { EveningPersonalizationScheduler } from './evening-personalization-scheduler';

describe('EveningPersonalizationScheduler', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-evening-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs once per local day after 6 PM', async () => {
    let now = new Date(2026, 7, 24, 17, 59);
    const onEvening = jest.fn().mockResolvedValue(true);
    const scheduler = new EveningPersonalizationScheduler({
      statePath: path.join(root, 'state.json'),
      onEvening,
      now: () => now,
    });

    expect(await scheduler.checkNow()).toBe(false);
    now = new Date(2026, 7, 24, 18, 0);
    expect(await scheduler.checkNow()).toBe(true);
    expect(await scheduler.checkNow()).toBe(false);
    expect(onEvening).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus()).toEqual(
      expect.objectContaining({
        scheduledHour: 18,
        lastStartedDate: '2026-08-24',
      }),
    );

    scheduler.markCompleted('completed');
    expect(scheduler.getStatus()).toEqual(
      expect.objectContaining({
        lastCompletedDate: '2026-08-24',
        lastOutcome: 'completed',
        lastCompletedAt: now.getTime(),
      }),
    );

    now = new Date(2026, 7, 25, 18, 1);
    expect(await scheduler.checkNow()).toBe(true);
    expect(onEvening).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus()).toEqual(
      expect.objectContaining({
        lastStartedDate: '2026-08-25',
        lastCompletedDate: '2026-08-24',
      }),
    );
  });

  it('retries when the transition could not complete', async () => {
    const onEvening = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const scheduler = new EveningPersonalizationScheduler({
      statePath: path.join(root, 'state.json'),
      onEvening,
      now: () => new Date(2026, 7, 24, 19, 0),
    });

    expect(await scheduler.checkNow()).toBe(false);
    expect(await scheduler.checkNow()).toBe(true);
    expect(onEvening).toHaveBeenCalledTimes(2);
  });
});
