/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import SkillWorkshop, { validateSkill } from './skill-workshop';
import SkillLibrary from './skill-library';

const draft = {
  name: 'team-update',
  description: 'Turn meeting notes into an update.',
  instructions: [
    'When to use',
    'Inputs',
    'Workflow',
    'Checkpoints',
    'Output',
    'Quality checks',
    'Examples',
  ]
    .map(
      (heading) => `## ${heading}\nPreserve facts and ask for missing details.`,
    )
    .join('\n\n'),
  files: [
    { name: 'template.md', content: '# Update\n- Decisions\n- Next steps' },
  ],
};
let root: string;
let workshop: SkillWorkshop;
let library: SkillLibrary;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-skill-workshop-'));
  library = new SkillLibrary(path.join(root, 'skills'));
  workshop = new SkillWorkshop(path.join(root, 'workshop'), library);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const response = (action: string, extra = {}) =>
  JSON.stringify({ action, message: 'Here is the next step.', ...extra });

test('guides drafting, executes a real trial, revises, and persists the tested package', async () => {
  const session = workshop.start();
  expect(workshop.start().sessionId).toBe(session.sessionId);
  const run = jest.fn(
    async (_prompt: string, _instructions: string, _execute?: boolean) =>
      response('draft', { draft }),
  );
  let state = await workshop.chat(
    session.sessionId,
    'Help me write weekly updates.',
    run,
  );
  expect(run.mock.calls[0][1]).toContain('not a numbered wizard or form');
  expect(state.messages.at(-1)?.text).toContain('template.md');
  expect(() => workshop.confirmSave(session.sessionId)).toThrow(
    'Test the latest',
  );
  run
    .mockResolvedValueOnce(
      response('test', { testInput: 'Shipped feature X.' }),
    )
    .mockResolvedValueOnce('Created update.md with the verified update.');
  state = await workshop.chat(
    session.sessionId,
    'Test it with feature X.',
    run,
  );
  expect(run.mock.calls.at(-1)?.[2]).toBe(true);
  expect(run.mock.calls.at(-1)?.[1]).toContain('creating requested artifacts');
  expect(state.trials[0]).toMatchObject({
    draftVersion: 1,
    output: 'Created update.md with the verified update.',
  });
  run.mockResolvedValueOnce(
    response('draft', {
      draft: {
        ...draft,
        instructions: `${draft.instructions}\nUse plain bullets.`,
      },
    }),
  );
  state = await workshop.chat(session.sessionId, 'Use plain bullets.', run);
  expect(state.version).toBe(2);
  expect(() => workshop.confirmSave(session.sessionId)).toThrow(
    'Test the latest',
  );
  run
    .mockResolvedValueOnce(response('test', { testInput: 'Shipped X.' }))
    .mockResolvedValueOnce('Updated update.md.');
  await workshop.chat(session.sessionId, 'Test the revised skill.', run);
  state = workshop.confirmSave(session.sessionId);
  expect(state.savedSkillId).toBe('team-update');
  expect(library.list()[0].files).toEqual(draft.files);
  expect(
    fs.readFileSync(
      path.join(library.directory('team-update'), 'SKILL.md'),
      'utf8',
    ),
  ).toContain('Use plain bullets.');
  expect(
    new SkillWorkshop(path.join(root, 'workshop'), library).get(
      session.sessionId,
    ),
  ).toEqual(state);
  const next = workshop.start();
  expect(next.sessionId).not.toBe(session.sessionId);
  expect(library.list()).toHaveLength(1);
});

test('model save actions cannot skip testing or interpret a refinement as confirmation', async () => {
  const { sessionId } = workshop.start();
  const run = jest.fn(async () => response('draft', { draft }));
  await workshop.chat(sessionId, 'Build a skill.', run);
  run.mockResolvedValueOnce(response('save'));
  await workshop.chat(sessionId, 'Save it.', run);
  expect(library.list()).toEqual([]);
  run
    .mockResolvedValueOnce(response('test', { testInput: 'Example' }))
    .mockResolvedValueOnce('Verified output.');
  await workshop.chat(sessionId, 'Test it.', run);
  run.mockResolvedValue(response('save'));
  await workshop.chat(sessionId, 'Save it.', run);
  expect(library.list()).toEqual([]);
  await workshop.chat(sessionId, 'Actually, change the tone.', run);
  expect(library.list()).toEqual([]);
  await workshop.chat(sessionId, 'yes', run);
  expect(library.list()).toHaveLength(1);
});

test('failed or stopped execution cannot become a successful trial', async () => {
  const { sessionId } = workshop.start();
  const run = jest.fn(async () => response('draft', { draft }));
  await workshop.chat(sessionId, 'Build it.', run);
  run
    .mockResolvedValueOnce(response('test', { testInput: 'Example' }))
    .mockRejectedValueOnce(new Error('Request stopped.'));
  await expect(workshop.chat(sessionId, 'Test it.', run)).rejects.toThrow(
    'stopped',
  );
  expect(workshop.get(sessionId)?.trials).toEqual([]);
  expect(() => workshop.confirmSave(sessionId)).toThrow('Test the latest');
});

test('pending generation blocks restart and saving; rejects invalid supporting files', async () => {
  const { sessionId } = workshop.start();
  let finish!: (value: string) => void;
  const pending = workshop.chat(
    sessionId,
    'Build it.',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(() => workshop.start(true)).toThrow('current skill request');
  expect(() => workshop.confirmSave(sessionId)).toThrow('current request');
  finish(response('draft', { draft }));
  await pending;
  expect(() =>
    validateSkill({
      ...draft,
      files: [{ name: '../escape.md', content: 'bad' }],
    }),
  ).toThrow('filenames');
});
