import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPersonalizationPreparationEstimate } from './personalization-preparation-estimate';

describe('readPersonalizationPreparationEstimate', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-preparation-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeProgress(value: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(root, 'retrospective_progress.json'),
      JSON.stringify(value),
    );
  }

  it('estimates remaining time from the current scan pace', () => {
    writeProgress({
      status: 'grounding',
      completed_steps: 4,
      total_steps: 10,
      processed_observations: 20,
      total_observations: 80,
      started_at: 100,
    });

    expect(
      readPersonalizationPreparationEstimate(root, 100_000, 140_000),
    ).toEqual({
      completedSteps: 4,
      totalSteps: 10,
      totalObservations: 80,
      remainingObservations: 60,
      estimatedSecondsRemaining: 60,
    });
  });

  it('waits for a completed step before estimating', () => {
    writeProgress({
      status: 'discovering',
      completed_steps: 0,
      total_steps: 10,
      total_observations: 80,
      started_at: 100,
    });

    expect(
      readPersonalizationPreparationEstimate(root, 100_000, 110_000),
    ).toEqual({
      completedSteps: 0,
      totalSteps: 10,
      totalObservations: 80,
      remainingObservations: 80,
    });
  });

  it('ignores stale progress from a previous run', () => {
    writeProgress({
      status: 'discovering',
      completed_steps: 4,
      total_steps: 10,
      total_observations: 80,
      started_at: 100,
    });

    expect(
      readPersonalizationPreparationEstimate(root, 200_000, 240_000),
    ).toBeUndefined();
  });

  it('reports a current completed scan as nearly ready', () => {
    writeProgress({
      status: 'complete',
      completed_steps: 10,
      total_steps: 10,
      processed_observations: 80,
      total_observations: 80,
      started_at: 100,
    });

    expect(
      readPersonalizationPreparationEstimate(root, 100_000, 140_000),
    ).toEqual({
      completedSteps: 10,
      totalSteps: 10,
      totalObservations: 80,
      remainingObservations: 0,
      estimatedSecondsRemaining: 0,
    });
  });
});
