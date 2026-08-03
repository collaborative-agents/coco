// Proactive observations are only useful while they are fresh. Electron/JS
// timers stop advancing while the computer sleeps, so without an explicit
// guard a pre-sleep event can appear as soon as the machine wakes.
export const WAKE_OBSERVATION_GRACE_MS = 15_000;
export const MAX_OBSERVATION_AGE_MS = 30_000;

export class ObservationSleepGuard {
  private suspended = false;

  private suppressUntilMs = 0;

  suspend() {
    this.suspended = true;
  }

  resume(nowMs = Date.now()) {
    this.suspended = false;
    this.suppressUntilMs = nowMs + WAKE_OBSERVATION_GRACE_MS;
  }

  shouldSuppress(eventTs?: number, nowMs = Date.now()): boolean {
    if (this.suspended || nowMs < this.suppressUntilMs) return true;
    if (typeof eventTs !== 'number' || !Number.isFinite(eventTs)) return false;

    // Sensing emits Unix seconds, but tolerate milliseconds for callers/tests.
    const eventMs = eventTs > 1_000_000_000_000 ? eventTs : eventTs * 1000;
    return nowMs - eventMs > MAX_OBSERVATION_AGE_MS;
  }
}
