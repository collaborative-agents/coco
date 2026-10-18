import { dialog } from 'electron';
import fs from 'fs/promises';
import JSZip from 'jszip';
import { registerStudyIpc } from './study-service';
import type { CocoGatewayClient } from './gateway-client';

jest.mock('electron', () => ({
  app: { getPath: jest.fn().mockReturnValue('/coco') },
  dialog: { showSaveDialog: jest.fn(), showOpenDialog: jest.fn() },
}));
jest.mock('fs/promises', () => ({
  __esModule: true,
  default: {
    copyFile: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn(),
  },
}));

function fixture(
  response: object,
  activityRecorder?: Parameters<typeof registerStudyIpc>[2],
  onPostAssessmentActiveChange?: Parameters<typeof registerStudyIpc>[3],
) {
  const requestJson = jest.fn().mockResolvedValue(response);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerStudyIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    () => ({ requestJson }) as unknown as CocoGatewayClient,
    activityRecorder,
    onPostAssessmentActiveChange,
  );
  return {
    requestJson,
    invoke: (name: string, ...args: unknown[]) =>
      handlers.get(name)!(null, ...args),
  };
}

beforeEach(() => jest.clearAllMocks());

it('previews task instructions through the unchanged authenticated download endpoint', async () => {
  const { invoke, requestJson } = fixture({
    filename: 'instructions.pdf',
    data: Buffer.from('%PDF-1.4 preview').toString('base64'),
  });
  const materials = await invoke('study-task-materials', 1);
  expect(materials.documents[0]).toMatchObject({
    id: 'instructions.pdf',
    kind: 'pdf',
  });
  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/days/1/download',
    'GET',
    undefined,
  );
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  expect(fs.writeFile).not.toHaveBeenCalled();
  await expect(invoke('study-task-materials', 8)).rejects.toThrow(
    'Invalid training day',
  );
});

it('downloads all references in one ZIP without including the instruction PDF', async () => {
  const zip = new JSZip();
  zip.file('Task/Day1_Instruction.pdf', '%PDF-1.4 instructions');
  zip.file('Task/style_guide.pdf', '%PDF-1.4 reference');
  zip.file('Task/data.csv', 'name,value\nA,10');
  const { invoke } = fixture({
    filename: 'day1.zip',
    data: await zip.generateAsync({ type: 'base64' }),
  });
  (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePath: '/chosen/references.zip',
  });
  await expect(invoke('study-save-references', 1)).resolves.toEqual({
    success: true,
  });
  const saved = await JSZip.loadAsync(
    (fs.writeFile as jest.Mock).mock.calls[0][1],
  );
  expect(
    Object.keys(saved.files)
      .filter((name) => !saved.files[name].dir)
      .sort(),
  ).toEqual(['Task/data.csv', 'Task/style_guide.pdf']);
  expect(await saved.file('Task/data.csv')!.async('string')).toBe(
    'name,value\nA,10',
  );
  (fs.writeFile as jest.Mock).mockClear();
  (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true });
  await expect(invoke('study-save-references', 1)).resolves.toEqual({
    canceled: true,
  });
  expect(fs.writeFile).not.toHaveBeenCalled();
});

it('does not create an empty reference archive for a standalone instruction PDF', async () => {
  const { invoke } = fixture({
    filename: 'task.pdf',
    data: Buffer.from('%PDF-1.4 instructions').toString('base64'),
  });
  await expect(invoke('study-save-references', 1)).resolves.toEqual({
    empty: true,
  });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});

it('saves only a selected material file and respects cancellation', async () => {
  const data = Buffer.from('Reference notes');
  const { invoke } = fixture({
    filename: 'notes.txt',
    data: data.toString('base64'),
  });
  (dialog.showSaveDialog as jest.Mock)
    .mockResolvedValueOnce({ canceled: true })
    .mockResolvedValueOnce({ canceled: false, filePath: '/chosen/notes.txt' });
  await expect(invoke('study-save-reference', 1, 'notes.txt')).resolves.toEqual(
    { canceled: true },
  );
  expect(fs.writeFile).not.toHaveBeenCalled();
  await expect(invoke('study-save-reference', 1, 'notes.txt')).resolves.toEqual(
    { success: true },
  );
  expect(fs.writeFile).toHaveBeenCalledWith('/chosen/notes.txt', data);
  await expect(invoke('study-save-reference', 1, '../missing')).rejects.toThrow(
    'no longer available',
  );
});

const reflection = {
  q1: 5,
  q2: 4,
  q3: 5,
  q4: 4,
  q5: 5,
  q6: 'Drafting a useful plan.',
  q7: 'I was briefly unsure about the prompt.',
  q8: 'I would like more examples.',
};

const questionnaire = {
  decision: 'I chose Plan B.',
  reasoning: 'It best balanced savings and risk.',
  aiUse: 'AI compared options; I checked the evidence.',
  alternatives: 'Plan A relied on an avoidable penalty.',
  challenge: 'Reconciling the contract dates.',
  ownership: 9,
};

const recorderState = {
  status: 'recording' as const,
  started_at: '2026-10-07T12:00:00Z',
  capture_count: 1,
  can_generate_log: true,
  last_error: null,
};

function fakeRecorder(automaticLog: Buffer | null = null) {
  return {
    begin: jest.fn().mockResolvedValue(recorderState),
    restore: jest.fn().mockResolvedValue(recorderState),
    pause: jest.fn().mockResolvedValue({ ...recorderState, status: 'paused' }),
    resume: jest.fn().mockResolvedValue(recorderState),
    captures: jest.fn().mockResolvedValue([]),
    removeCapture: jest.fn().mockResolvedValue(recorderState),
    buildAutomaticLog: jest.fn().mockResolvedValue(
      automaticLog
        ? {
            filename: 'post-assessment-activity-log.html',
            data: automaticLog,
          }
        : null,
    ),
    completeAndDelete: jest.fn().mockResolvedValue(undefined),
  };
}

it('requires and saves a screenshot locally when completing a training day', async () => {
  const screenshot = Buffer.from('image');
  const { invoke, requestJson } = fixture({ success: true });
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/favorite-moment.png'],
  });
  (fs.stat as jest.Mock).mockResolvedValue({ size: screenshot.length });

  await expect(
    invoke('study-complete', 1, 'alice', reflection),
  ).resolves.toEqual({
    success: true,
  });
  expect(fs.mkdir).toHaveBeenCalledWith('/coco/training-screenshots/alice', {
    recursive: true,
  });
  expect(fs.copyFile).toHaveBeenCalledWith(
    '/chosen/favorite-moment.png',
    '/coco/training-screenshots/alice/day-1.png',
  );
  expect(fs.mkdir).toHaveBeenCalledWith('/coco/training-reflections/alice', {
    recursive: true,
  });
  expect(fs.writeFile).toHaveBeenCalledWith(
    '/coco/training-reflections/alice/day-1.json',
    expect.stringContaining('"q6": "Drafting a useful plan."'),
    'utf8',
  );
  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/days/1/complete',
    'POST',
    { completed: true, reflection },
  );
});

it('does not complete a training day when screenshot selection is cancelled', async () => {
  const { invoke, requestJson } = fixture({ success: true });
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: true,
    filePaths: [],
  });

  await expect(
    invoke('study-complete', 1, 'alice', reflection),
  ).resolves.toEqual({ canceled: true });
  expect(requestJson).not.toHaveBeenCalled();
  expect(fs.copyFile).not.toHaveBeenCalled();
});

it('requires every reflection answer before opening the screenshot chooser', async () => {
  const { invoke, requestJson } = fixture({ success: true });

  await expect(
    invoke('study-complete', 1, 'alice', { ...reflection, q7: ' ' }),
  ).rejects.toThrow('Please answer every reflection question.');

  expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  expect(requestJson).not.toHaveBeenCalled();
});

it('saves an authenticated download only to the user-selected location', async () => {
  const { invoke, requestJson } = fixture({
    filename: 'task.pdf',
    data: Buffer.from('pdf').toString('base64'),
  });
  (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePath: '/chosen/task.pdf',
  });
  expect(await invoke('study-download', 1)).toEqual({ success: true });
  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/days/1/download',
    'GET',
    undefined,
  );
  expect(fs.writeFile).toHaveBeenCalledWith(
    '/chosen/task.pdf',
    Buffer.from('pdf'),
  );
});
it('does not save when the chooser is cancelled', async () => {
  const { invoke } = fixture({ filename: 'task.pdf', data: 'YWJj' });
  (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true });
  await invoke('study-download', 1);
  expect(fs.writeFile).not.toHaveBeenCalled();
});

it('starts recording for an existing execution without resetting its timer', async () => {
  const recorder = fakeRecorder();
  const { invoke, requestJson } = fixture(
    {
      execution_started_at: '2026-10-07T12:00:00Z',
      sections: { execution: null },
    },
    recorder,
  );

  await expect(invoke('post-assessment-recorder-start')).resolves.toEqual(
    recorderState,
  );
  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/post-assessment',
    'GET',
    undefined,
  );
  expect(recorder.begin).toHaveBeenCalledWith('2026-10-07T12:00:00Z');
});

it('restores proactive-suggestion suppression from active post-assessment state', async () => {
  const onPostAssessmentActiveChange = jest.fn();
  const { invoke } = fixture(
    {
      unlocked: true,
      complete: false,
      execution_started_at: '2026-10-07T12:00:00Z',
      sections: { execution: null },
    },
    undefined,
    onPostAssessmentActiveChange,
  );

  await invoke('post-assessment-state');

  expect(onPostAssessmentActiveChange).toHaveBeenCalledWith(true);
});

it('restores proactive suggestions after the post-assessment is complete', async () => {
  const onPostAssessmentActiveChange = jest.fn();
  const { invoke } = fixture(
    { unlocked: true, complete: true, sections: { execution: {} } },
    undefined,
    onPostAssessmentActiveChange,
  );

  await invoke('post-assessment-state');

  expect(onPostAssessmentActiveChange).toHaveBeenCalledWith(false);
});

it('rejects out-of-range days and unsafe download names', async () => {
  const { invoke, requestJson } = fixture({
    filename: '../bad.pdf',
    data: 'YWJj',
  });
  await expect(invoke('study-download', 8)).rejects.toThrow(
    'Invalid training day',
  );
  expect(requestJson).not.toHaveBeenCalled();
  await expect(invoke('study-download', 1)).rejects.toThrow(
    'Invalid training file',
  );
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});
it('does not open an upload chooser for a participant', async () => {
  const { invoke } = fixture({ role: 'participant' });
  await expect(invoke('study-upload', 1, 'Task')).rejects.toThrow(
    'Administrator access required',
  );
  expect(dialog.showOpenDialog).not.toHaveBeenCalled();
});

it('downloads the complete post-assessment toolkit from the server', async () => {
  const archive = Buffer.from('zip-data');
  const { invoke, requestJson } = fixture({
    filename: 'post-assessment-toolkit.zip',
    data: archive.toString('base64'),
  });
  (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePath: '/chosen/post-assessment-toolkit.zip',
  });

  await expect(invoke('post-assessment-download-toolkit')).resolves.toEqual({
    success: true,
  });
  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/post-assessment/toolkit/download',
    'GET',
    undefined,
  );
  expect(fs.writeFile).toHaveBeenCalledWith(
    '/chosen/post-assessment-toolkit.zip',
    archive,
  );
});

it('lets an administrator upload the post-assessment toolkit ZIP', async () => {
  const archive = Buffer.from('zip-data');
  const { invoke, requestJson } = fixture({ role: 'admin', success: true });
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/toolkit.zip'],
  });
  (fs.stat as jest.Mock).mockResolvedValue({ size: archive.length });
  (fs.readFile as jest.Mock).mockResolvedValue(archive);

  await invoke('study-upload-post-assessment-toolkit');

  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/admin/post-assessment/toolkit',
    'POST',
    {
      filename: 'toolkit.zip',
      data: archive.toString('base64'),
    },
    60000,
  );
});

it('starts the task, required recorder, and suggestion suppression together', async () => {
  const recorder = fakeRecorder();
  const onPostAssessmentActiveChange = jest.fn();
  const { invoke, requestJson } = fixture(
    { execution_started_at: '2026-10-07T12:00:00Z' },
    recorder,
    onPostAssessmentActiveChange,
  );

  await invoke('post-assessment-start-execution');

  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/post-assessment/execution/start',
    'POST',
    undefined,
  );
  expect(recorder.begin).toHaveBeenCalledWith('2026-10-07T12:00:00Z');
  expect(onPostAssessmentActiveChange).toHaveBeenCalledWith(true);
});

it('automatically attaches the recorded activity report', async () => {
  const automaticLog = Buffer.from('<html>activity</html>');
  const recorder = fakeRecorder(automaticLog);
  const { invoke, requestJson } = fixture(
    { completed_at: '2026-10-07T12:30:00Z' },
    recorder,
  );
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/answer.pdf'],
  });
  (fs.stat as jest.Mock).mockResolvedValue({ size: 12 });
  (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('%PDF-answer'));

  await invoke('post-assessment-select-execution-files', 'outcome');
  await invoke('post-assessment-submit-execution', questionnaire);

  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/post-assessment/execution',
    'POST',
    expect.objectContaining({
      interaction_logs: [
        {
          filename: 'post-assessment-activity-log.html',
          data: automaticLog.toString('base64'),
        },
      ],
    }),
    300000,
  );
  expect(recorder.completeAndDelete).toHaveBeenCalled();
});

it('requires the generated recording report and rejects manual log files', async () => {
  const { invoke, requestJson } = fixture({ success: true }, fakeRecorder());
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/answer.pdf'],
  });

  await invoke('post-assessment-select-execution-files', 'outcome');
  await expect(
    invoke('post-assessment-select-execution-files', 'interaction_logs'),
  ).rejects.toThrow('Unknown post-assessment file type.');
  await expect(
    invoke('post-assessment-submit-execution', questionnaire),
  ).rejects.toThrow('Task activity recording is required before submitting.');

  expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  expect(requestJson).not.toHaveBeenCalled();
});

it('validates and uploads the execution task files and questionnaire', async () => {
  const automaticLog = Buffer.from('<html>recorded activity</html>');
  const { invoke, requestJson } = fixture(
    { completed_at: '2026-10-07T12:00:00Z' },
    fakeRecorder(automaticLog),
  );
  (fs.stat as jest.Mock).mockResolvedValue({ size: 12 });
  (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('%PDF-answer'));
  (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/answer.pdf'],
  });

  await invoke('post-assessment-select-execution-files', 'outcome');

  await invoke('post-assessment-submit-execution', questionnaire);

  expect(requestJson).toHaveBeenCalledWith(
    '/api/study/post-assessment/execution',
    'POST',
    {
      questionnaire: {
        decision: questionnaire.decision,
        reasoning: questionnaire.reasoning,
        ai_use: questionnaire.aiUse,
        alternatives: questionnaire.alternatives,
        challenge: questionnaire.challenge,
        ownership: 9,
      },
      outcome: {
        filename: 'answer.pdf',
        data: Buffer.from('%PDF-answer').toString('base64'),
      },
      interaction_logs: [
        {
          filename: 'post-assessment-activity-log.html',
          data: automaticLog.toString('base64'),
        },
      ],
    },
    300000,
  );
});

it('rejects an incomplete post-assessment submission before reading files', async () => {
  const { invoke, requestJson } = fixture({ success: true });

  await expect(
    invoke('post-assessment-submit-execution', {
      ...questionnaire,
      challenge: ' ',
    }),
  ).rejects.toThrow('Please answer every questionnaire question.');
  expect(fs.stat).not.toHaveBeenCalled();
  expect(requestJson).not.toHaveBeenCalled();
});
