import fs from 'fs/promises';
import registerTrainingSubmissionIpc from './training-submission-ipc';

jest.mock('electron', () => ({ app: { getPath: () => '/coco' } }));
jest.mock('fs/promises', () => ({
  __esModule: true,
  default: { stat: jest.fn(), readFile: jest.fn() },
}));

const answers = {
  q1: 5,
  q2: 4,
  q3: 3,
  q4: 2,
  q5: 1,
  q6: 'Useful',
  q7: 'Challenging',
  q8: 'More practice',
};
const record = { day: 1, user_id: 'alice', answers };
const missingFile = Object.assign(new Error('Missing'), { code: 'ENOENT' });
const account = {
  user_id: 'alice',
  days: [{ day: 1, completed_at: '2026-10-12' }],
};
function fixture(me: unknown = account) {
  const currentAccount = jest.fn().mockResolvedValue(me);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerTrainingSubmissionIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    currentAccount,
  );
  return {
    currentAccount,
    invoke: (day: unknown) => handlers.get('study-task-submission')!(null, day),
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  (fs.stat as jest.Mock).mockImplementation(async (filename: string) => {
    if (filename.endsWith('.json') || filename.endsWith('.png'))
      return { size: 100, mtimeMs: 1 };
    throw missingFile;
  });
  (fs.readFile as jest.Mock).mockImplementation(async (filename: string) =>
    filename.endsWith('.json')
      ? JSON.stringify(record)
      : Buffer.from('screenshot'),
  );
});

it('reads the signed-in user’s reflection and screenshot without writing or posting', async () => {
  const { invoke, currentAccount } = fixture();
  await expect(invoke(1)).resolves.toEqual({
    answers,
    screenshotDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
  });
  expect(currentAccount).toHaveBeenCalledWith();
  expect(fs.readFile).toHaveBeenCalledWith(
    '/coco/training-reflections/alice/day-1.json',
    'utf8',
  );
  expect(fs.readFile).toHaveBeenCalledWith(
    '/coco/training-screenshots/alice/day-1.png',
  );
});

it.each([0, 8, '../alice', 1.5])(
  'rejects invalid day %s before accessing data',
  async (day) => {
    const { invoke, currentAccount } = fixture();
    await expect(invoke(day)).rejects.toThrow('Invalid training day');
    expect(currentAccount).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  },
);

it('does not show a locally saved attempt until completion is confirmed', async () => {
  const { invoke } = fixture({
    ...account,
    days: [{ day: 1, completed_at: null }],
  });
  await expect(invoke(1)).resolves.toBeNull();
  expect(fs.stat).not.toHaveBeenCalled();
});

it('returns an empty result when the local reflection is missing', async () => {
  (fs.stat as jest.Mock).mockRejectedValue(missingFile);
  await expect(fixture().invoke(1)).resolves.toBeNull();
});

it('retains reflection answers when the screenshot is missing', async () => {
  (fs.stat as jest.Mock).mockImplementation(async (filename: string) => {
    if (filename.endsWith('.json')) return { size: 100 };
    throw missingFile;
  });
  await expect(fixture().invoke(1)).resolves.toEqual({
    answers,
    screenshotDataUrl: null,
  });
});

it('rejects records belonging to another account in a colliding legacy folder', async () => {
  (fs.readFile as jest.Mock).mockResolvedValue(
    JSON.stringify({ ...record, user_id: 'someone-else' }),
  );
  await expect(fixture().invoke(1)).rejects.toThrow('does not match');
  expect(fs.readFile).toHaveBeenCalledTimes(1);
});

it('rejects malformed answers and oversized files', async () => {
  (fs.readFile as jest.Mock).mockResolvedValue(
    JSON.stringify({ ...record, answers: { ...answers, q1: 9 } }),
  );
  await expect(fixture().invoke(1)).rejects.toThrow(
    'Saved reflection is invalid',
  );
  (fs.stat as jest.Mock).mockResolvedValue({ size: 200 * 1024 });
  await expect(fixture().invoke(1)).rejects.toThrow(
    'Saved reflection is too large',
  );
});
