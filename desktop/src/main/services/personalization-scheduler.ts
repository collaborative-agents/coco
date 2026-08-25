import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import log from 'electron-log';

export type PersonalizationJob = 'signals' | 'revise' | 'evolve';

export type PersonalizationRunOutcome =
  | 'completed'
  | 'no_work'
  | 'preempted'
  | 'failed';

export interface PersonalizationStatus {
  available: boolean;
  sleeping: boolean;
  state: 'idle' | 'running' | 'checkpointed' | PersonalizationRunOutcome;
  activeJob?: PersonalizationJob;
  activeStartedAt?: number;
  checkpointStatus?: string;
  processedSamples?: number;
  totalSamples?: number;
  periodStart?: number;
  periodEnd?: number;
  signals?: {
    signalCount: number;
    observationCount: number;
    feedbackEventCount: number;
    updatedAt?: number;
  };
  lastRun?: {
    job: PersonalizationJob;
    outcome: PersonalizationRunOutcome;
    endedAt: number;
    detail?: string;
  };
  nextEvolveAttemptAt?: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftRecord = left ?? {};
  const rightRecord = right ?? {};
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => leftRecord[key] === rightRecord[key])
  );
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

function countJsonLines(filePath: string): number | undefined {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim()).length;
  } catch {
    return undefined;
  }
}

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
  /** Parallel prediction/reflection requests within one Coco-PE batch. */
  evolveConcurrency?: number;
  /** Dedicated subprocess log, alongside the sensing and tutor service logs. */
  logPath?: string;
  onJobComplete?: (job: PersonalizationJob) => void;
}

/** Owns one low-priority, disposable personalization subprocess at a time. */
export class PersonalizationScheduler {
  private active: ChildProcess | null = null;

  private activeJob: PersonalizationJob | null = null;

  private activeStartedAt: number | null = null;

  private activeOutput = '';

  private lastRun: PersonalizationStatus['lastRun'];

  private interactiveCount = 0;

  private sleeping = false;

  private pendingSignals = true;

  private observationsSinceSignals = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  private stopped = false;

  private dedicatedLogReady = false;

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
    this.writeDedicatedLog('Personalization scheduler started');
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

  updateModelConfiguration(
    model: string,
    providerEnv?: Record<string, string>,
  ) {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new Error('Personalization model ID is required.');
    }
    if (
      this.options.model === normalizedModel &&
      sameStringRecord(this.options.providerEnv, providerEnv)
    ) {
      return;
    }

    this.options.model = normalizedModel;
    this.options.providerEnv = providerEnv ? { ...providerEnv } : undefined;
    this.writeDedicatedLog(
      `Model configuration updated: model=${normalizedModel}`,
    );
    this.preempt('model configuration changed');
  }

  /** Return live scheduler state enriched with resume-safe disk checkpoints. */
  getStatus(): PersonalizationStatus {
    const signalCheckpoint = readJson(
      path.join(this.options.stateRoot, 'signals_checkpoint.json'),
    );
    const evolveCheckpoint = readJson(
      path.join(this.options.stateRoot, 'evolve_checkpoint.json'),
    );
    const activeRun = asObject(evolveCheckpoint?.active_run);
    const runDir = stringValue(activeRun?.run_dir);
    const snapshotPath = stringValue(activeRun?.snapshot_path);
    const resumeState = runDir
      ? readJson(path.join(runDir, 'resume_state.json'))
      : undefined;
    const totalSamples = snapshotPath
      ? countJsonLines(snapshotPath)
      : undefined;
    const checkpointStatus =
      stringValue(resumeState?.status) ?? stringValue(activeRun?.status);
    let processedSamples = numberValue(resumeState?.n_seen);
    if (
      totalSamples !== undefined &&
      (checkpointStatus === 'finalizing' || activeRun?.status === 'complete')
    ) {
      processedSamples = totalSamples;
    }

    let state: PersonalizationStatus['state'] = 'idle';
    if (this.active && this.activeJob) state = 'running';
    else if (activeRun?.status === 'running') state = 'checkpointed';
    else if (activeRun?.status === 'complete') state = 'completed';
    else if (this.lastRun) state = this.lastRun.outcome;

    return {
      available: true,
      sleeping: this.sleeping,
      state,
      ...(this.activeJob && { activeJob: this.activeJob }),
      ...(this.activeStartedAt && { activeStartedAt: this.activeStartedAt }),
      ...(checkpointStatus && { checkpointStatus }),
      ...(processedSamples !== undefined && { processedSamples }),
      ...(totalSamples !== undefined && { totalSamples }),
      ...(numberValue(activeRun?.period_start) !== undefined && {
        periodStart: numberValue(activeRun?.period_start),
      }),
      ...(numberValue(activeRun?.period_end) !== undefined && {
        periodEnd: numberValue(activeRun?.period_end),
      }),
      ...(signalCheckpoint && {
        signals: {
          signalCount: numberValue(signalCheckpoint.signal_count) ?? 0,
          observationCount:
            numberValue(signalCheckpoint.observation_count) ?? 0,
          feedbackEventCount:
            numberValue(signalCheckpoint.feedback_event_count) ?? 0,
          ...(numberValue(signalCheckpoint.updated_at) !== undefined && {
            updatedAt: numberValue(signalCheckpoint.updated_at),
          }),
        },
      }),
      ...(this.lastRun && { lastRun: this.lastRun }),
      ...(this.nextAllowedAt.evolve > Date.now() && {
        nextEvolveAttemptAt: this.nextAllowedAt.evolve,
      }),
    };
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
      common.push(
        '--memory-root',
        this.options.memoryRoot,
        '--llm-concurrency',
        String(this.options.evolveConcurrency ?? 4),
      );
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
    this.writeDedicatedLog(
      `Starting bounded ${job} job\nCommand: ${command} ${args.join(' ')}`,
    );
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
    this.activeJob = job;
    this.activeStartedAt = Date.now();
    this.activeOutput = '';
    child.stdout?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        this.activeOutput = message;
        log.info(`[Personalization:${job}] ${message}`);
        this.writeDedicatedLog(`[${job}:stdout]\n${message}`);
      }
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        log.warn(`[Personalization:${job}] ${message}`);
        this.writeDedicatedLog(`[${job}:stderr]\n${message}`);
      }
    });
    child.on('error', (error) => {
      log.warn(`[Personalization] ${job} failed to start`, error);
      this.writeDedicatedLog(`[${job}:spawn-error] ${error.stack ?? error}`);
    });
    child.on('exit', (code, signal) => {
      if (this.active === child) this.active = null;
      if (this.activeJob === job) this.activeJob = null;
      this.activeStartedAt = null;
      if (job === 'signals' && (code !== 0 || signal)) {
        this.pendingSignals = true;
      }
      const noWork = code === 3;
      let outcome: PersonalizationRunOutcome = 'failed';
      if (signal) outcome = 'preempted';
      else if (noWork) outcome = 'no_work';
      else if (code === 0) outcome = 'completed';
      this.lastRun = {
        job,
        outcome,
        endedAt: Date.now(),
        ...(this.activeOutput && { detail: this.activeOutput }),
      };
      this.activeOutput = '';
      let cooldownMs = 5_000;
      if (noWork) {
        cooldownMs = job === 'evolve' ? 15 * 60_000 : 5 * 60_000;
      } else if (outcome === 'failed') {
        // A persistent model/configuration error should not spawn a new heavy
        // worker every scheduler tick. Keep preemption quick, but back off real
        // failures long enough for resources or configuration to recover.
        cooldownMs = job === 'evolve' ? 15 * 60_000 : 5 * 60_000;
      }
      this.nextAllowedAt[job] = Date.now() + cooldownMs;
      log.info(`[Personalization] ${job} exited code=${code} signal=${signal}`);
      this.writeDedicatedLog(
        `${job} exited code=${String(code)} signal=${String(signal)}`,
      );
      if (code === 0) this.options.onJobComplete?.(job);
      if (!this.stopped) setTimeout(() => this.tick(), 1_000);
    });
  }

  private preempt(reason: string) {
    const child = this.active;
    if (!child?.pid) return;
    log.info(`[Personalization] preempting active job: ${reason}`);
    this.writeDedicatedLog(`Preempting active job: ${reason}`);
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

  private writeDedicatedLog(message: string) {
    const { logPath } = this.options;
    if (!logPath) return;
    try {
      if (!this.dedicatedLogReady) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        if (
          fs.existsSync(logPath) &&
          fs.statSync(logPath).size > 5 * 1024 * 1024
        ) {
          const oldPath = `${logPath}.old`;
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          fs.renameSync(logPath, oldPath);
        }
        this.dedicatedLogReady = true;
      }
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] ${message.trim()}\n`,
        'utf8',
      );
    } catch (error) {
      log.warn('[Personalization] failed to write dedicated log', error);
    }
  }
}
