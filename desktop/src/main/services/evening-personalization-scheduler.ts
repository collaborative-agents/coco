import fs from 'fs';
import path from 'path';
import log from 'electron-log';

const CHECK_INTERVAL_MS = 60_000;
const EVENING_HOUR = 18;

interface EveningState {
  lastTriggeredDate?: string;
}

export interface EveningPersonalizationSchedulerOptions {
  statePath: string;
  onEvening: () => Promise<boolean>;
  now?: () => Date;
  checkIntervalMs?: number;
}

/** Runs the end-of-day transition once per local calendar day after 6 PM. */
export class EveningPersonalizationScheduler {
  private readonly options: EveningPersonalizationSchedulerOptions;

  private timer: ReturnType<typeof setInterval> | null = null;

  private running = false;

  constructor(options: EveningPersonalizationSchedulerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkNow().catch(() => undefined);
    }, this.options.checkIntervalMs ?? CHECK_INTERVAL_MS);
    this.checkNow().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<boolean> {
    if (this.running) return false;
    const now = this.options.now?.() ?? new Date();
    if (now.getHours() < EVENING_HOUR) return false;

    const date = EveningPersonalizationScheduler.localDateKey(now);
    if (this.readState().lastTriggeredDate === date) return false;

    this.running = true;
    try {
      const completed = await this.options.onEvening();
      if (!completed) return false;
      this.writeState({ lastTriggeredDate: date });
      return true;
    } catch (error) {
      log.warn(
        `[Evening] End-of-day transition failed: ${(error as Error).message}`,
      );
      return false;
    } finally {
      this.running = false;
    }
  }

  private static localDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private readState(): EveningState {
    try {
      const value = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  private writeState(state: EveningState): void {
    fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.options.statePath);
  }
}
