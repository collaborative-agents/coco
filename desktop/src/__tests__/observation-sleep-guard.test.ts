import {
  MAX_OBSERVATION_AGE_MS,
  ObservationSleepGuard,
  WAKE_OBSERVATION_GRACE_MS,
} from '../main/observation-sleep-guard';

describe('ObservationSleepGuard', () => {
  const now = 2_000_000_000_000;

  it('suppresses observations while suspended', () => {
    const guard = new ObservationSleepGuard();
    guard.suspend();
    expect(guard.shouldSuppress(now / 1000, now)).toBe(true);
  });

  it('suppresses observations during the wake grace period', () => {
    const guard = new ObservationSleepGuard();
    guard.suspend();
    guard.resume(now);

    expect(
      guard.shouldSuppress(
        (now + WAKE_OBSERVATION_GRACE_MS - 1) / 1000,
        now + WAKE_OBSERVATION_GRACE_MS - 1,
      ),
    ).toBe(true);
    expect(
      guard.shouldSuppress(
        (now + WAKE_OBSERVATION_GRACE_MS) / 1000,
        now + WAKE_OBSERVATION_GRACE_MS,
      ),
    ).toBe(false);
  });

  it('drops stale events after the grace period', () => {
    const guard = new ObservationSleepGuard();
    expect(
      guard.shouldSuppress((now - MAX_OBSERVATION_AGE_MS - 1) / 1000, now),
    ).toBe(true);
    expect(
      guard.shouldSuppress((now - MAX_OBSERVATION_AGE_MS) / 1000, now),
    ).toBe(false);
  });

  it('accepts missing timestamps outside suspension and grace periods', () => {
    const guard = new ObservationSleepGuard();
    expect(guard.shouldSuppress(undefined, now)).toBe(false);
  });
});
