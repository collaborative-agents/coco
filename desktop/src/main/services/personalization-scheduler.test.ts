import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PersonalizationScheduler,
  type PersonalizationRunEvent,
} from './personalization-scheduler';

describe('PersonalizationScheduler status', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'coco-personalization-status-'),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports resume-safe Coco-PE sample progress from checkpoints', () => {
    const stateRoot = path.join(root, 'personalization');
    const runDir = path.join(stateRoot, 'runs', 'period-1000');
    const snapshotPath = path.join(runDir, 'labeled_moments.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      `${Array.from({ length: 8 }, (_, index) =>
        JSON.stringify({ id: index }),
      ).join('\n')}\n`,
    );
    fs.writeFileSync(
      path.join(stateRoot, 'evolve_checkpoint.json'),
      JSON.stringify({
        active_run: {
          status: 'running',
          period_start: 900,
          period_end: 1000,
          run_dir: runDir,
          snapshot_path: snapshotPath,
        },
      }),
    );
    fs.writeFileSync(
      path.join(runDir, 'resume_state.json'),
      JSON.stringify({ status: 'running', n_seen: 5 }),
    );

    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot,
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
    });

    expect(scheduler.getStatus()).toEqual(
      expect.objectContaining({
        available: true,
        state: 'checkpointed',
        checkpointStatus: 'running',
        processedSamples: 5,
        totalSamples: 8,
        periodStart: 900,
        periodEnd: 1000,
      }),
    );
  });

  it('does not report a previous completed run as current progress', () => {
    const stateRoot = path.join(root, 'personalization');
    const oldRunDir = path.join(stateRoot, 'runs', 'period-1000');
    const oldSnapshotPath = path.join(oldRunDir, 'labeled_moments.jsonl');
    fs.mkdirSync(oldRunDir, { recursive: true });
    fs.writeFileSync(
      oldSnapshotPath,
      `${Array.from({ length: 8 }, (_, index) =>
        JSON.stringify({ id: index }),
      ).join('\n')}\n`,
    );
    fs.writeFileSync(
      path.join(oldRunDir, 'resume_state.json'),
      JSON.stringify({ status: 'complete', n_seen: 0 }),
    );
    fs.writeFileSync(
      path.join(stateRoot, 'evolve_checkpoint.json'),
      JSON.stringify({
        active_run: {
          run_id: 'period-1000',
          status: 'complete',
          period_start: 900,
          period_end: 1000,
          run_dir: oldRunDir,
          snapshot_path: oldSnapshotPath,
        },
      }),
    );

    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot,
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
    });
    const internals = scheduler as unknown as {
      active: Record<string, never>;
      activeJob: 'evolve';
      activeStartedAt: number;
      evolveCheckpointAtStart: { runId: string; status: string };
    };
    internals.active = {};
    internals.activeJob = 'evolve';
    internals.activeStartedAt = Date.now() - 40_000;
    internals.evolveCheckpointAtStart = {
      runId: 'period-1000',
      status: 'complete',
    };
    fs.writeFileSync(
      path.join(stateRoot, 'retrospective_progress.json'),
      JSON.stringify({
        status: 'grounding',
        completed_steps: 4,
        total_steps: 10,
        processed_observations: 20,
        total_observations: 80,
        started_at: internals.activeStartedAt / 1_000,
      }),
    );

    const preparingStatus = scheduler.getStatus();
    expect(preparingStatus).toEqual(
      expect.objectContaining({
        state: 'running',
        activeJob: 'evolve',
        checkpointStatus: 'preparing',
        preparation: expect.objectContaining({
          completedSteps: 4,
          totalSteps: 10,
          totalObservations: 80,
          remainingObservations: 60,
          estimatedSecondsRemaining: expect.any(Number),
        }),
      }),
    );
    expect(preparingStatus.processedSamples).toBeUndefined();
    expect(preparingStatus.totalSamples).toBeUndefined();

    const currentRunDir = path.join(stateRoot, 'runs', 'period-2000');
    const currentSnapshotPath = path.join(
      currentRunDir,
      'labeled_moments.jsonl',
    );
    fs.mkdirSync(currentRunDir, { recursive: true });
    fs.writeFileSync(
      currentSnapshotPath,
      `${Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({ id: index }),
      ).join('\n')}\n`,
    );
    fs.writeFileSync(
      path.join(currentRunDir, 'resume_state.json'),
      JSON.stringify({ status: 'running', n_seen: 2 }),
    );
    fs.writeFileSync(
      path.join(stateRoot, 'evolve_checkpoint.json'),
      JSON.stringify({
        active_run: {
          run_id: 'period-2000',
          status: 'running',
          run_dir: currentRunDir,
          snapshot_path: currentSnapshotPath,
        },
      }),
    );

    expect(scheduler.getStatus()).toEqual(
      expect.objectContaining({
        state: 'running',
        checkpointStatus: 'running',
        processedSamples: 2,
        totalSamples: 6,
      }),
    );
  });

  it('counts unique successful desktop personalization updates', () => {
    const memoryRoot = path.join(root, 'memory');
    const draftsRoot = path.join(memoryRoot, 'memory_drafts');
    ['draft-1', 'draft-1-copy', 'draft-2', 'manual-draft'].forEach(
      (draftId) => {
        fs.mkdirSync(path.join(draftsRoot, draftId), { recursive: true });
      },
    );
    fs.writeFileSync(
      path.join(draftsRoot, 'draft-1', 'memory_draft.json'),
      JSON.stringify({ source_run_id: 'desktop:run-1' }),
    );
    fs.writeFileSync(
      path.join(draftsRoot, 'draft-1-copy', 'memory_draft.json'),
      JSON.stringify({ source_run_id: 'desktop:run-1' }),
    );
    fs.writeFileSync(
      path.join(draftsRoot, 'draft-2', 'memory_draft.json'),
      JSON.stringify({ source_run_id: 'desktop:run-2' }),
    );
    fs.writeFileSync(
      path.join(draftsRoot, 'manual-draft', 'memory_draft.json'),
      JSON.stringify({ source_run_id: 'self-evolve:manual' }),
    );

    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
    });

    expect(scheduler.getStatus().successfulUpdateCount).toBe(2);
  });

  it('writes raw multiline output to the dedicated personalization log', () => {
    const logPath = path.join(root, 'logs', 'personalization.log');
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      logPath,
    });

    const logWriter = scheduler as unknown as {
      writeDedicatedLog: (message: string) => void;
    };
    logWriter.writeDedicatedLog(
      "[evolve:stderr]\nTraceback line\nFailed to execute script 'runtime'",
    );

    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      "[evolve:stderr]\nTraceback line\nFailed to execute script 'runtime'",
    );
  });

  it('passes bounded LLM concurrency to the evolve worker', () => {
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      evolveConcurrency: 3,
    });
    const commandBuilder = scheduler as unknown as {
      command: (job: 'evolve') => { args: string[] };
    };

    const { args } = commandBuilder.command('evolve');

    expect(args).toEqual(expect.arrayContaining(['--llm-concurrency', '3']));
  });

  it('can bypass retrospective preparation for a local demo', () => {
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      skipRetrospective: true,
    });
    const commandBuilder = scheduler as unknown as {
      command: (job: 'evolve') => { args: string[] };
    };

    expect(commandBuilder.command('evolve').args).toContain(
      '--skip-retrospective',
    );
  });

  it('uses updated model settings without restarting the scheduler', () => {
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'gemini/gemini-2.5-pro',
      providerEnv: { GEMINI_API_KEY: 'old-key' },
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
    });
    const schedulerInternals = scheduler as unknown as {
      command: (job: 'evolve') => { args: string[] };
      options: {
        providerEnv?: Record<string, string>;
      };
      preempt: (reason: string) => void;
    };
    const preempt = jest.spyOn(schedulerInternals, 'preempt');

    scheduler.updateModelConfiguration('hosted_vllm/Qwen/VL', {
      HOSTED_VLLM_API_BASE: 'https://inference.example.test/v1',
      HOSTED_VLLM_API_KEY: 'new-key',
    });

    const { args } = schedulerInternals.command('evolve');
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'hosted_vllm/Qwen/VL']),
    );
    expect(args).not.toContain('gemini/gemini-2.5-pro');
    expect(schedulerInternals.options.providerEnv).toEqual({
      HOSTED_VLLM_API_BASE: 'https://inference.example.test/v1',
      HOSTED_VLLM_API_KEY: 'new-key',
    });
    expect(preempt).toHaveBeenCalledWith('model configuration changed');

    scheduler.updateModelConfiguration('hosted_vllm/Qwen/VL', {
      HOSTED_VLLM_API_BASE: 'https://inference.example.test/v1',
      HOSTED_VLLM_API_KEY: 'new-key',
    });
    expect(preempt).toHaveBeenCalledTimes(1);
  });

  it('reports every finished job while reserving completion for successful updates', () => {
    const onJobComplete = jest.fn();
    const onJobFinished = jest.fn();
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      onJobComplete,
      onJobFinished,
    });
    const schedulerInternals = scheduler as unknown as {
      notifyJobFinished: (
        job: 'evolve',
        outcome: 'completed' | 'no_work' | 'failed',
      ) => void;
    };

    schedulerInternals.notifyJobFinished('evolve', 'completed');
    schedulerInternals.notifyJobFinished('evolve', 'no_work');
    schedulerInternals.notifyJobFinished('evolve', 'failed');

    expect(onJobFinished).toHaveBeenNthCalledWith(1, 'evolve', 'completed');
    expect(onJobFinished).toHaveBeenNthCalledWith(2, 'evolve', 'no_work');
    expect(onJobFinished).toHaveBeenNthCalledWith(3, 'evolve', 'failed');
    expect(onJobComplete).toHaveBeenCalledTimes(1);
    expect(onJobComplete).toHaveBeenCalledWith('evolve');
  });

  it('reports bounded personalization subprocess failures', () => {
    const onFatalError = jest.fn();
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      onFatalError,
    });
    const schedulerInternals = scheduler as unknown as {
      notifyFatalError: (error: {
        job: 'evolve';
        failureType: 'unexpected_exit';
        message: string;
        exitCode: number;
      }) => void;
    };

    schedulerInternals.notifyFatalError({
      job: 'evolve',
      failureType: 'unexpected_exit',
      message: 'worker failed',
      exitCode: 1,
    });

    expect(onFatalError).toHaveBeenCalledWith({
      job: 'evolve',
      failureType: 'unexpected_exit',
      message: 'worker failed',
      exitCode: 1,
    });
  });

  it('forwards every personalization run lifecycle state', () => {
    const onRunEvent = jest.fn();
    const scheduler = new PersonalizationScheduler({
      projectRoot: root,
      recordsRoot: path.join(root, 'records'),
      stateRoot: path.join(root, 'personalization'),
      memoryRoot: root,
      model: 'provider/model',
      collectTrainingScreenshots: false,
      getIdleSeconds: () => 0,
      onRunEvent,
    });
    const schedulerInternals = scheduler as unknown as {
      notifyRunEvent: (event: PersonalizationRunEvent) => void;
    };
    const states: PersonalizationRunEvent['state'][] = [
      'started',
      'completed',
      'no_work',
      'preempted',
      'failed',
    ];

    states.forEach((state, index) => {
      schedulerInternals.notifyRunEvent({
        runId: 'run-1',
        job: 'evolve',
        state,
        occurredAt: 1_000 + index,
        startedAt: 1_000,
      });
    });

    expect(onRunEvent.mock.calls.map(([event]) => event.state)).toEqual(states);
  });
});
