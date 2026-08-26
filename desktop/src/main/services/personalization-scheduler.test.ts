import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersonalizationScheduler } from './personalization-scheduler';

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
});
