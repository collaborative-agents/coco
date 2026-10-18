import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextDaySummaryScheduler } from './next-day-summary-scheduler';

describe('NextDaySummaryScheduler', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-daily-summary-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs once on the first use of each local day', async () => {
    let now = new Date(2026, 7, 24, 9, 15);
    const onFirstUse = jest.fn().mockResolvedValue(true);
    const scheduler = new NextDaySummaryScheduler({
      statePath: path.join(root, 'state.json'),
      onFirstUse,
      now: () => now,
    });

    expect(await scheduler.checkNow()).toBe(true);
    expect(await scheduler.checkNow()).toBe(false);
    expect(onFirstUse).toHaveBeenCalledTimes(1);
    expect(onFirstUse).toHaveBeenLastCalledWith({
      dateKey: '2026-08-24',
      startTs: Math.floor(new Date(2026, 7, 24, 0, 0).getTime() / 1000),
    });

    now = new Date(2026, 7, 25, 7, 30);
    expect(await scheduler.checkNow()).toBe(true);
    expect(onFirstUse).toHaveBeenCalledTimes(2);
  });

  it('retries later when another notification prevents display', async () => {
    const onFirstUse = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const scheduler = new NextDaySummaryScheduler({
      statePath: path.join(root, 'state.json'),
      onFirstUse,
      now: () => new Date(2026, 7, 24, 9, 15),
    });

    expect(await scheduler.checkNow()).toBe(false);
    expect(await scheduler.checkNow()).toBe(true);
    expect(onFirstUse).toHaveBeenCalledTimes(2);
  });
});
