import { ChildProcess, spawn } from 'child_process';
import log from 'electron-log';

type PersonalizationJob = 'signals' | 'revise' | 'evolve';

export interface PersonalizationSchedulerOptions {
  projectRoot: string;
  recordsRoot: string;
  stateRoot: string;
  memoryRoot: string;
  model: string;
  packagedExecutable?: string;
  providerEnv?: Record<string, string>;
  collectTrainingScreenshots: boolean;
  getIdleSeconds: () => number;
  revisionIdleSeconds?: number;
  evolveIdleSeconds?: number;
  missedObservationInterval?: number;
  onJobComplete?: (job: PersonalizationJob) => void;
}

/** Owns one low-priority, disposable personalization subprocess at a time. */
export class PersonalizationScheduler {
  private active: ChildProcess | null = null;

  private interactiveCount = 0;

  private sleeping = false;

  private pendingSignals = true;

  private observationsSinceSignals = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  private stopped = false;

  private readonly nextAllowedAt: Record<PersonalizationJob, number> = {
    signals: 0,
    revise: 0,
    evolve: 0,
  };

  private readonly options: PersonalizationSchedulerOptions;

  constructor(options: PersonalizationSchedulerOptions) {
    this.options = options;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 15_000);
    this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.preempt('scheduler stopped');
  }

  noteFeedback() {
    this.pendingSignals = true;
    this.tick();
  }

  noteObservation() {
    this.observationsSinceSignals += 1;
    const interval = this.options.missedObservationInterval ?? 20;
    if (this.observationsSinceSignals >= interval) {
      this.observationsSinceSignals = 0;
      this.pendingSignals = true;
      this.tick();
    }
  }

  beginInteractiveInference() {
    this.interactiveCount += 1;
    this.preempt('interactive inference requested');
  }

  endInteractiveInference() {
    this.interactiveCount = Math.max(0, this.interactiveCount - 1);
  }

  setSleepMode(sleeping: boolean) {
    this.sleeping = sleeping;
    if (!sleeping) this.preempt('Coco resumed');
    this.tick();
  }

  isSleeping() {
    return this.sleeping;
  }

  private tick() {
    if (this.stopped || this.active || this.interactiveCount > 0) return;
    if (this.pendingSignals) {
      this.pendingSignals = false;
      this.run('signals');
      return;
    }
    if (this.sleeping) {
      if (Date.now() >= this.nextAllowedAt.evolve) this.run('evolve');
      return;
    }
    const idleSeconds = this.options.getIdleSeconds();
    const now = Date.now();
    if (
      idleSeconds >= (this.options.evolveIdleSeconds ?? 10 * 60) &&
      now >= this.nextAllowedAt.evolve
    ) {
      this.run('evolve');
    } else if (
      idleSeconds >= (this.options.revisionIdleSeconds ?? 60) &&
      now >= this.nextAllowedAt.revise
    ) {
      this.run('revise');
    }
  }

  private command(job: PersonalizationJob): {
    command: string;
    args: string[];
  } {
    const common = [
      job,
      '--records-root',
      this.options.recordsRoot,
      '--state-root',
      this.options.stateRoot,
      '--missed-observation-interval',
      String(this.options.missedObservationInterval ?? 20),
    ];
    if (job !== 'signals') common.push('--model', this.options.model);
    if (job === 'evolve') {
      common.push('--memory-root', this.options.memoryRoot);
      if (this.options.collectTrainingScreenshots) {
        common.push('--collect-training-screenshots');
      }
    }
    if (this.options.packagedExecutable) {
      return { command: this.options.packagedExecutable, args: common };
    }
    return {
      command: 'uv',
      args: [
        'run',
        '--package',
        'personalization',
        'python',
        '-m',
        'personalization.runtime',
        ...common,
      ],
    };
  }

  private run(job: PersonalizationJob) {
    const base = this.command(job);
    const useNice = process.platform !== 'win32';
    const command = useNice ? 'nice' : base.command;
    const args = useNice ? ['-n', '15', base.command, ...base.args] : base.args;
    log.info(`[Personalization] starting bounded ${job} job`);
    const child = spawn(command, args, {
      cwd: this.options.projectRoot,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...this.options.providerEnv,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = child;
    child.stdout?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) log.info(`[Personalization:${job}] ${message}`);
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) log.warn(`[Personalization:${job}] ${message}`);
    });
    child.on('error', (error) => {
      log.warn(`[Personalization] ${job} failed to start`, error);
    });
    child.on('exit', (code, signal) => {
      if (this.active === child) this.active = null;
      if (job === 'signals' && (code !== 0 || signal)) {
        this.pendingSignals = true;
      }
      const noWork = code === 3;
      let cooldownMs = 5_000;
      if (noWork) {
        cooldownMs = job === 'evolve' ? 15 * 60_000 : 5 * 60_000;
      }
      this.nextAllowedAt[job] = Date.now() + cooldownMs;
      log.info(`[Personalization] ${job} exited code=${code} signal=${signal}`);
      if (code === 0) this.options.onJobComplete?.(job);
      if (!this.stopped) setTimeout(() => this.tick(), 1_000);
    });
  }

  private preempt(reason: string) {
    const child = this.active;
    if (!child?.pid) return;
    log.info(`[Personalization] preempting active job: ${reason}`);
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      log.warn('[Personalization] graceful preemption failed', error);
      child.kill('SIGKILL');
    }
    setTimeout(() => {
      if (this.active !== child || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process exited between the liveness check and signal.
      }
    }, 1_000);
  }
}
