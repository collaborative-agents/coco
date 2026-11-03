import fs from 'fs';
import path from 'path';

export interface PersonalizationPreparationEstimate {
  completedSteps: number;
  totalSteps: number;
  totalObservations: number;
  remainingObservations: number;
  estimatedSecondsRemaining?: number;
}

interface PreparationProgressFile {
  status?: unknown;
  completed_steps?: unknown;
  total_steps?: unknown;
  processed_observations?: unknown;
  total_observations?: unknown;
  started_at?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Read the current retrospective scan's lightweight progress checkpoint. */
export function readPersonalizationPreparationEstimate(
  stateRoot: string,
  activeStartedAt: number,
  now = Date.now(),
): PersonalizationPreparationEstimate | undefined {
  let progress: PreparationProgressFile;
  try {
    progress = JSON.parse(
      fs.readFileSync(
        path.join(stateRoot, 'retrospective_progress.json'),
        'utf8',
      ),
    ) as PreparationProgressFile;
  } catch {
    return undefined;
  }

  const startedAtSeconds = finiteNumber(progress.started_at);
  const rawCompletedSteps = finiteNumber(progress.completed_steps);
  const rawTotalSteps = finiteNumber(progress.total_steps);
  const rawProcessedObservations = finiteNumber(
    progress.processed_observations,
  );
  const rawTotalObservations = finiteNumber(progress.total_observations);
  if (
    startedAtSeconds === undefined ||
    rawCompletedSteps === undefined ||
    rawTotalSteps === undefined ||
    rawTotalObservations === undefined ||
    rawTotalObservations < 0 ||
    rawTotalSteps <= 0
  ) {
    return undefined;
  }

  const startedAt = startedAtSeconds * 1000;
  // The previous run's progress file remains on disk. Only use a checkpoint
  // created by this process, allowing a small timestamp precision tolerance.
  if (startedAt < activeStartedAt - 5_000) return undefined;

  const totalSteps = Math.max(1, Math.floor(rawTotalSteps));
  const totalObservations = Math.floor(rawTotalObservations);
  const completedSteps = Math.min(
    totalSteps,
    Math.max(0, Math.floor(rawCompletedSteps)),
  );
  const processedObservations = Math.min(
    totalObservations,
    Math.max(
      0,
      Math.floor(
        rawProcessedObservations ??
          (progress.status === 'grounding'
            ? (completedSteps / totalSteps) * totalObservations
            : 0),
      ),
    ),
  );
  const remainingObservations = totalObservations - processedObservations;
  const remainingSteps = totalSteps - completedSteps;
  if (remainingSteps === 0 || progress.status === 'complete') {
    return {
      completedSteps,
      totalSteps,
      totalObservations,
      remainingObservations: 0,
      estimatedSecondsRemaining: 0,
    };
  }
  if (completedSteps === 0) {
    return {
      completedSteps,
      totalSteps,
      totalObservations,
      remainingObservations,
    };
  }

  const elapsedSeconds = Math.max(1, (now - startedAt) / 1_000);
  const secondsPerStep = elapsedSeconds / completedSteps;
  return {
    completedSteps,
    totalSteps,
    totalObservations,
    remainingObservations,
    estimatedSecondsRemaining: Math.max(
      1,
      Math.round(secondsPerStep * remainingSteps),
    ),
  };
}
