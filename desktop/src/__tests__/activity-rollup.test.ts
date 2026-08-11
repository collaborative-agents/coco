import {
  ActivityRecord,
  laneOf,
} from '../renderer/components/observation-types';
import {
  buildSegments,
  dayStartOf,
  summarizeDay,
} from '../renderer/components/activity-rollup';

describe('activity history support classification', () => {
  it('uses need_support as the authoritative History lane', () => {
    expect(laneOf('mistake', 'yes')).toBe('focus');
    expect(laneOf('inefficient', 'no')).toBe('watching');
  });

  it('uses the same support decision for timeline colors and counts', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const records: ActivityRecord[] = [
      {
        ts: nowSec - 20,
        status: 'mistake',
        need_support: 'yes',
        observation: 'A stale focus status with an explicit support decision.',
      },
      {
        ts: nowSec - 10,
        status: 'inefficient',
        need_support: 'no',
        observation:
          'A stale assist status with an explicit no-support decision.',
      },
    ];

    expect(
      buildSegments(records, nowSec).map((segment) => segment.lane),
    ).toEqual(['focus', 'watching']);

    const summary = summarizeDay(records, dayStartOf(nowSec), nowSec);
    expect(summary.flowPct).toBe(50);
    expect(summary.focusCount).toBe(1);
    expect(summary.assistCount).toBe(0);
  });

  it('keeps legacy status mapping for records without need_support', () => {
    expect(laneOf('mistake')).toBe('focus');
    expect(laneOf('inefficient')).toBe('assist');
    expect(laneOf('support_needed')).toBe('focus');
  });
});
