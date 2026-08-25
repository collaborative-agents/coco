import fs from 'fs';
import path from 'path';
import log from 'electron-log';

interface NextDaySummaryState {
  lastHandledDate?: string;
}

export interface CurrentDayBoundary {
  dateKey: string;
  startTs: number;
}

export interface NextDaySummarySchedulerOptions {
  statePath: string;
  onFirstUse: (today: CurrentDayBoundary) => Promise<boolean>;
  now?: () => Date;
}

/** Offers an unreviewed learning recap on the first observed use of each day. */
export class NextDaySummaryScheduler {
  private readonly options: NextDaySummarySchedulerOptions;

  private running = false;

  constructor(options: NextDaySummarySchedulerOptions) {
    this.options = options;
  }

  async checkNow(): Promise<boolean> {
    if (this.running) return false;

    const now = this.options.now?.() ?? new Date();
    const todayKey = NextDaySummaryScheduler.localDateKey(now);
    if (this.readState().lastHandledDate === todayKey) return false;

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const today = {
      dateKey: todayKey,
      startTs: Math.floor(todayStart.getTime() / 1000),
    };

    this.running = true;
    try {
      const handled = await this.options.onFirstUse(today);
      if (!handled) return false;
      this.writeState({ lastHandledDate: todayKey });
      return true;
    } catch (error) {
      log.warn(
        `[Daily summary] First-use transition failed: ${(error as Error).message}`,
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

  private readState(): NextDaySummaryState {
    try {
      const value = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  private writeState(state: NextDaySummaryState): void {
    fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.options.statePath);
  }
}
