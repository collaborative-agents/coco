import { app, type IpcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import type { DailyReflection, StudyState } from '../../shared/study';
import type { TrainingSubmission } from '../../shared/training-submission';

const missing = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'ENOENT';

function parseAnswers(raw: unknown): DailyReflection {
  if (!raw || typeof raw !== 'object')
    throw new Error('Saved reflection is invalid.');
  const answers = raw as DailyReflection;
  const ratings = [answers.q1, answers.q2, answers.q3, answers.q4, answers.q5];
  const writing = [answers.q6, answers.q7, answers.q8];
  if (
    ratings.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 5,
    ) ||
    writing.some((value) => typeof value !== 'string' || value.length > 5000)
  ) {
    throw new Error('Saved reflection is invalid.');
  }
  return answers;
}

/** Read-only desktop adapter. Uses the existing account endpoint; no backend changes. */
export default function registerTrainingSubmissionIpc(
  ipc: Pick<IpcMain, 'handle'>,
  currentAccount: () => Promise<unknown>,
) {
  ipc.handle(
    'study-task-submission',
    async (_event, day: unknown): Promise<TrainingSubmission | null> => {
      if (!Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
        throw new Error('Invalid training day.');
      const me = (await currentAccount()) as StudyState;
      if (typeof me?.user_id !== 'string' || !me.user_id.trim())
        throw new Error('Please sign in to review your submission.');
      if (!me.days?.some((item) => item.day === day && item.completed_at))
        return null;
      const userId = me.user_id.trim();
      const folder = userId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      if (folder === '.' || folder === '..')
        throw new Error('Invalid account folder.');
      const root = app.getPath('userData');
      const reflectionPath = path.join(
        root,
        'training-reflections',
        folder,
        `day-${day}.json`,
      );
      let record;
      try {
        if ((await fs.stat(reflectionPath)).size > 128 * 1024)
          throw new Error('Saved reflection is too large.');
        record = JSON.parse(await fs.readFile(reflectionPath, 'utf8'));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      // Existing folder names are sanitized: verify identity before returning any local files.
      if (record?.user_id !== userId || record?.day !== day)
        throw new Error(
          'Saved submission does not match this account and day.',
        );
      const answers = parseAnswers(record.answers);
      const candidates = await Promise.all(
        ['png', 'jpg', 'jpeg', 'webp'].map(async (extension) => {
          const filename = path.join(
            root,
            'training-screenshots',
            folder,
            `day-${day}.${extension}`,
          );
          try {
            const stat = await fs.stat(filename);
            return {
              filename,
              extension,
              size: stat.size,
              modified: stat.mtimeMs,
            };
          } catch (error) {
            if (missing(error)) return null;
            throw error;
          }
        }),
      );
      const screenshot = candidates
        .filter((item) => item !== null)
        .sort((a, b) => b.modified - a.modified)[0];
      if (!screenshot) return { answers, screenshotDataUrl: null };
      if (screenshot.size > 10 * 1024 * 1024)
        throw new Error('Saved screenshot is too large.');
      const bytes = await fs.readFile(screenshot.filename);
      const mime =
        screenshot.extension === 'jpg' ? 'jpeg' : screenshot.extension;
      return {
        answers,
        screenshotDataUrl: `data:image/${mime};base64,${bytes.toString('base64')}`,
      };
    },
  );
}
