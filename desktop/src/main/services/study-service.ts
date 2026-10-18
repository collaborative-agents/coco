import { app, dialog } from 'electron';
import log from 'electron-log';
import fs from 'fs/promises';
import path from 'path';
import type { IpcMain } from 'electron';
import type { CocoGatewayClient } from './gateway-client';
import type { DailyReflection, StudyState } from '../../shared/study';
import registerTrainingMaterialsIpc from './training-materials-ipc';
import registerTrainingSubmissionIpc from './training-submission-ipc';
import {
  type AiLiteracyAnswers,
  type ExecutionQuestionnaire,
  type SelfEfficacyAnswers,
} from '../../shared/post-assessment';
import {
  createPostAssessmentActivityRecorder,
  type PostAssessmentActivityRecorder,
} from '../post-assessment-recorder';

type StudyActivityRecorder = Pick<
  PostAssessmentActivityRecorder,
  | 'begin'
  | 'restore'
  | 'pause'
  | 'resume'
  | 'captures'
  | 'removeCapture'
  | 'buildAutomaticLog'
  | 'completeAndDelete'
>;

const MAX_POST_ASSESSMENT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_POST_ASSESSMENT_TOTAL_BYTES = 72 * 1024 * 1024;

function validReflection(raw: unknown): DailyReflection {
  if (!raw || typeof raw !== 'object')
    throw new Error('Please answer every reflection question.');
  const candidate = raw as Partial<DailyReflection>;
  const ratings = [
    candidate.q1,
    candidate.q2,
    candidate.q3,
    candidate.q4,
    candidate.q5,
  ];
  const responses = [candidate.q6, candidate.q7, candidate.q8];
  if (
    ratings.some(
      (rating) =>
        !Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 5,
    ) ||
    responses.some(
      (response) =>
        typeof response !== 'string' ||
        !response.trim() ||
        response.trim().length > 5000,
    )
  )
    throw new Error('Please answer every reflection question.');
  return {
    q1: Number(candidate.q1),
    q2: Number(candidate.q2),
    q3: Number(candidate.q3),
    q4: Number(candidate.q4),
    q5: Number(candidate.q5),
    q6: candidate.q6!.trim(),
    q7: candidate.q7!.trim(),
    q8: candidate.q8!.trim(),
  };
}

function validQuestionnaire(raw: unknown): ExecutionQuestionnaire {
  if (!raw || typeof raw !== 'object')
    throw new Error('Please answer every questionnaire question.');
  const candidate = raw as Partial<ExecutionQuestionnaire>;
  const textKeys = [
    'decision',
    'reasoning',
    'aiUse',
    'alternatives',
    'challenge',
  ] as const;
  const answers = Object.fromEntries(
    textKeys.map((key) => [
      key,
      typeof candidate[key] === 'string' ? candidate[key]!.trim() : '',
    ]),
  ) as unknown as Omit<ExecutionQuestionnaire, 'ownership'>;
  if (
    textKeys.some((key) => !answers[key] || answers[key].length > 5000) ||
    !Number.isInteger(candidate.ownership) ||
    Number(candidate.ownership) < 1 ||
    Number(candidate.ownership) > 10
  )
    throw new Error('Please answer every questionnaire question.');
  return { ...answers, ownership: Number(candidate.ownership) };
}

// The named export keeps registration explicit at the main-process composition root.
// eslint-disable-next-line import/prefer-default-export
export function registerStudyIpc(
  ipc: Pick<IpcMain, 'handle'>,
  gateway: () => CocoGatewayClient | null,
  activityRecorder: StudyActivityRecorder = createPostAssessmentActivityRecorder(),
  onPostAssessmentActiveChange: (active: boolean) => void = () => undefined,
) {
  let selectedOutcomePath: string | null = null;
  const request = (
    route: string,
    method?: 'GET' | 'POST' | 'PATCH',
    body?: object,
    timeoutMs?: number,
  ) => {
    const client = gateway();
    if (!client) throw new Error('Please sign in to use Training.');
    if (timeoutMs !== undefined)
      return client.requestJson(
        `/api/study${route}`,
        method ?? 'GET',
        body,
        timeoutMs,
      );
    return client.requestJson(`/api/study${route}`, method ?? 'GET', body);
  };
  const dayNumber = (day: unknown): number => {
    if (!Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
      throw new Error('Invalid training day.');
    return Number(day);
  };
  const userPath = (id: string) => {
    if (typeof id !== 'string' || !id.trim())
      throw new Error('Username is required.');
    return `/admin/users/${encodeURIComponent(id.trim())}`;
  };
  ipc.handle('study-me', () => request('/me'));
  registerTrainingSubmissionIpc(ipc, () => request('/me'));
  registerTrainingMaterialsIpc(ipc, (day) =>
    request(`/days/${dayNumber(day)}/download`),
  );
  ipc.handle('study-start', (_event, timezone: string) =>
    request('/start', 'POST', { timezone }),
  );
  ipc.handle(
    'study-complete',
    async (_event, day: number, userId: string, rawReflection: unknown) => {
      const validDay = dayNumber(day);
      if (typeof userId !== 'string' || !userId.trim())
        throw new Error('Username is required.');
      const reflection = validReflection(rawReflection);
      const selected = await dialog.showOpenDialog({
        title: 'Share the most exciting part of your work',
        buttonLabel: 'Use screenshot',
        properties: ['openFile'],
        filters: [
          { name: 'Screenshot', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        ],
      });
      if (selected.canceled || !selected.filePaths[0])
        return { canceled: true };
      const file = selected.filePaths[0];
      const extension = path.extname(file).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension))
        throw new Error('Screenshot must be a PNG, JPEG, or WebP image.');
      if ((await fs.stat(file)).size > 10 * 1024 * 1024)
        throw new Error('Screenshot exceeds 10 MiB.');
      const userFolder = userId
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
      const screenshotFolder = path.join(
        app.getPath('userData'),
        'training-screenshots',
        userFolder,
      );
      await fs.mkdir(screenshotFolder, { recursive: true });
      await fs.copyFile(
        file,
        path.join(screenshotFolder, `day-${validDay}${extension}`),
      );
      const reflectionFolder = path.join(
        app.getPath('userData'),
        'training-reflections',
        userFolder,
      );
      await fs.mkdir(reflectionFolder, { recursive: true });
      await fs.writeFile(
        path.join(reflectionFolder, `day-${validDay}.json`),
        `${JSON.stringify(
          {
            day: validDay,
            user_id: userId.trim(),
            submitted_at: new Date().toISOString(),
            answers: reflection,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      return request(`/days/${validDay}/complete`, 'POST', {
        completed: true,
        reflection,
      });
    },
  );
  ipc.handle('study-admin-users', (_event, after = '') =>
    request(`/admin/users?after=${encodeURIComponent(after)}`),
  );
  ipc.handle('study-admin-role', (_event, id: string, admin: boolean) =>
    request(`${userPath(id)}/role`, 'PATCH', { admin }),
  );
  ipc.handle('study-admin-tutoring', (_event, id: string, disabled: boolean) =>
    request(`${userPath(id)}/tutoring`, 'PATCH', { disabled }),
  );
  const saveDownload = async (route: string, title: string) => {
    const file = await request(route);
    if (
      typeof file.filename !== 'string' ||
      path.basename(file.filename) !== file.filename ||
      /[\\\\]/.test(file.filename) ||
      file.filename.includes('\0') ||
      typeof file.data !== 'string' ||
      file.data.length > 28 * 1024 * 1024
    )
      throw new Error('Invalid training file.');
    const destination = await dialog.showSaveDialog({
      title,
      defaultPath: file.filename,
    });
    if (destination.canceled || !destination.filePath)
      return { canceled: true };
    await fs.writeFile(destination.filePath, Buffer.from(file.data, 'base64'));
    return { success: true };
  };
  ipc.handle('study-download', async (_event, day: number) =>
    saveDownload(`/days/${dayNumber(day)}/download`, 'Save training task'),
  );
  ipc.handle('study-upload', async (_event, day: number, title: string) => {
    dayNumber(day);
    const me = (await request('/me')) as unknown as StudyState;
    if (me.role === 'participant')
      throw new Error('Administrator access required.');
    const selected = await dialog.showOpenDialog({
      title: 'Select training material (up to 20 MiB)',
      properties: ['openFile'],
      filters: [{ name: 'Training material', extensions: ['pdf', 'zip'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const file = selected.filePaths[0];
    if ((await fs.stat(file)).size > 20 * 1024 * 1024)
      throw new Error('File exceeds 20 MiB.');
    return request(`/admin/materials/${day}`, 'POST', {
      title,
      filename: path.basename(file),
      data: (await fs.readFile(file)).toString('base64'),
    });
  });
  ipc.handle('study-upload-post-assessment-toolkit', async () => {
    const me = (await request('/me')) as unknown as StudyState;
    if (me.role === 'participant')
      throw new Error('Administrator access required.');
    const selected = await dialog.showOpenDialog({
      title: 'Select post-assessment toolkit ZIP (up to 20 MiB)',
      properties: ['openFile'],
      filters: [{ name: 'Post-assessment toolkit', extensions: ['zip'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const file = selected.filePaths[0];
    if (path.extname(file).toLowerCase() !== '.zip')
      throw new Error('Post-assessment toolkit must be a ZIP file.');
    if ((await fs.stat(file)).size > 20 * 1024 * 1024)
      throw new Error('File exceeds 20 MiB.');
    return request(
      '/admin/post-assessment/toolkit',
      'POST',
      {
        filename: path.basename(file),
        data: (await fs.readFile(file)).toString('base64'),
      },
      60000,
    );
  });
  ipc.handle('post-assessment-state', async () => {
    const state = (await request('/post-assessment')) as {
      unlocked?: unknown;
      complete?: unknown;
      execution_started_at?: unknown;
      sections?: { execution?: unknown };
    };
    onPostAssessmentActiveChange(
      state.unlocked === true && state.complete !== true,
    );
    return state;
  });
  ipc.handle(
    'post-assessment-submit-self-efficacy',
    (_event, answers: SelfEfficacyAnswers) =>
      request('/post-assessment/self-efficacy', 'POST', { responses: answers }),
  );
  ipc.handle(
    'post-assessment-submit-ai-literacy',
    (_event, answers: AiLiteracyAnswers) =>
      request('/post-assessment/ai-literacy', 'POST', { responses: answers }),
  );
  ipc.handle('post-assessment-start-execution', async () => {
    const result = (await request(
      '/post-assessment/execution/start',
      'POST',
    )) as { execution_started_at?: unknown };
    if (typeof result.execution_started_at !== 'string')
      throw new Error('The study server did not return the task start time.');
    selectedOutcomePath = null;
    onPostAssessmentActiveChange(true);
    await activityRecorder.begin(result.execution_started_at);
    return result;
  });
  ipc.handle('post-assessment-recorder-state', (_event, startedAt: unknown) =>
    activityRecorder.restore(typeof startedAt === 'string' ? startedAt : null),
  );
  ipc.handle('post-assessment-recorder-start', async () => {
    const state = (await request('/post-assessment')) as {
      execution_started_at?: unknown;
      sections?: { execution?: unknown };
    };
    if (state.sections?.execution)
      throw new Error('The execution task has already been submitted.');
    if (typeof state.execution_started_at !== 'string')
      throw new Error('Start the execution task first.');
    return activityRecorder.begin(state.execution_started_at);
  });
  ipc.handle('post-assessment-recorder-pause', () => activityRecorder.pause());
  ipc.handle('post-assessment-recorder-resume', () =>
    activityRecorder.resume(),
  );
  ipc.handle('post-assessment-recorder-captures', () =>
    activityRecorder.captures(),
  );
  ipc.handle(
    'post-assessment-recorder-remove-capture',
    (_event, captureId: unknown) => {
      if (typeof captureId !== 'string' || !captureId)
        throw new Error('Invalid task capture.');
      return activityRecorder.removeCapture(captureId);
    },
  );
  ipc.handle('post-assessment-download-toolkit', () =>
    saveDownload(
      '/post-assessment/toolkit/download',
      'Save post-assessment toolkit',
    ),
  );
  ipc.handle(
    'post-assessment-submit-execution',
    async (_event, rawQuestionnaire: unknown) => {
      const questionnaire = validQuestionnaire(rawQuestionnaire);
      if (!selectedOutcomePath)
        throw new Error('Choose your completed answer sheet as a PDF.');
      const automaticLog = await activityRecorder.buildAutomaticLog();
      if (!automaticLog)
        throw new Error(
          'Task activity recording is required before submitting. Start or resume recording and try again.',
        );
      const outcomeSize = await fs.stat(selectedOutcomePath);
      if (
        outcomeSize.size < 1 ||
        outcomeSize.size > MAX_POST_ASSESSMENT_FILE_BYTES
      )
        throw new Error(
          'Each submission file must be between 1 byte and 64 MiB.',
        );
      const outcomeData = await fs.readFile(selectedOutcomePath);
      if (
        outcomeData.length + automaticLog.data.length >
        MAX_POST_ASSESSMENT_TOTAL_BYTES
      )
        throw new Error('The combined submission files exceed 72 MiB.');
      const result = await request(
        '/post-assessment/execution',
        'POST',
        {
          questionnaire: {
            decision: questionnaire.decision,
            reasoning: questionnaire.reasoning,
            ai_use: questionnaire.aiUse,
            alternatives: questionnaire.alternatives,
            challenge: questionnaire.challenge,
            ownership: questionnaire.ownership,
          },
          outcome: {
            filename: path.basename(selectedOutcomePath),
            data: outcomeData.toString('base64'),
          },
          interaction_logs: [
            {
              filename: automaticLog.filename,
              data: automaticLog.data.toString('base64'),
            },
          ],
        },
        300000,
      );
      selectedOutcomePath = null;
      try {
        await activityRecorder.completeAndDelete();
      } catch (error) {
        log.warn(
          `[Post-assessment] Submission succeeded but local recording cleanup failed: ${String(error)}`,
        );
      }
      return result;
    },
  );
  ipc.handle(
    'post-assessment-select-execution-files',
    async (_event, kind: unknown) => {
      if (kind !== 'outcome')
        throw new Error('Unknown post-assessment file type.');
      const selected = await dialog.showOpenDialog({
        title: 'Select completed answer sheet PDF',
        buttonLabel: 'Use answer sheet',
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (selected.canceled || selected.filePaths.length === 0)
        return { canceled: true };
      if (path.extname(selected.filePaths[0]).toLowerCase() !== '.pdf')
        throw new Error('Choose your completed answer sheet as a PDF.');
      [selectedOutcomePath] = selected.filePaths;
      return {
        success: true,
        filenames: [path.basename(selectedOutcomePath)],
      };
    },
  );
}
