/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import SkillLibrary from './skill-library';

let root: string;
let library: SkillLibrary;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-skills-'));
  library = new SkillLibrary(path.join(root, 'library'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('created skills persist and their edits invalidate the runtime resource key', () => {
  const skill = library.create({
    name: 'review',
    description: 'Review a document',
    instructions: 'Read the document and report issues.',
  });
  expect(new SkillLibrary(path.join(root, 'library')).list()).toEqual([skill]);
  const before = library.runtimeSkills();
  fs.appendFileSync(
    path.join(library.directory(skill.id), 'SKILL.md'),
    '\nAsk before publishing.',
  );
  expect(library.runtimeSkills().revision).not.toBe(before.revision);
  expect(before.paths).toEqual([library.directory(skill.id)]);
  expect(() =>
    library.create({
      name: 'review',
      description: 'Duplicate',
      instructions: 'Overwrite',
    }),
  ).toThrow('already exists');
});

test('imports YAML descriptions and supporting files into the owned library', () => {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: review\ndescription: >\n  Review a document\n  carefully.\n---\nFollow references/rubric.md.',
  );
  fs.writeFileSync(path.join(source, 'references/rubric.md'), 'Check clarity.');
  const imported = library.import(source);
  expect(imported.description).toContain('Review a document carefully.');
  expect(imported.files).toEqual([
    { name: 'references/rubric.md', content: 'Check clarity.' },
  ]);
  fs.rmSync(source, { recursive: true });
  expect(library.list()).toEqual([imported]);
});

test('rejects path traversal and symlink packages without granting access', () => {
  expect(() =>
    library.create({
      name: '../escape',
      description: 'Bad',
      instructions: 'Bad',
    }),
  ).toThrow();
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: unsafe\ndescription: Unsafe\n---\nInstructions',
  );
  fs.symlinkSync(root, path.join(source, 'outside'));
  expect(() => library.import(source)).toThrow('symbolic links');
  expect(library.runtimeSkills().paths).toEqual([]);
});
