import type { DailyReflection } from './study';

/** A desktop-local copy of a completed practice submission. */
export interface TrainingSubmission {
  answers: DailyReflection;
  screenshotDataUrl: string | null;
}
