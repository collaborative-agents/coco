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
});
