import { parse } from 'yaml';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { CuratedSkill } from '../../shared/skills';

/** Only explicitly imported packages are exposed to the agent. */
export default class SkillLibrary {
  constructor(private readonly root: string) {}

  private package(folder: string): CuratedSkill {
    const skillFile = path.join(folder, 'SKILL.md');
    if (
      !fs.lstatSync(skillFile).isFile() ||
      fs.statSync(skillFile).size > 1024 * 1024
    )
      throw new Error('SKILL.md must be a regular file smaller than 1 MB.');
    const markdown = fs.readFileSync(skillFile, 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
    const metadata = parse(header ?? '', { maxAliasCount: 0 });
    const name = metadata?.name;
    const description = metadata?.description;
    if (
      typeof name !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      name.length > 64 ||
      typeof description !== 'string' ||
      !description.trim()
    )
      throw new Error(
        'SKILL.md needs a lowercase hyphenated name and description in its frontmatter.',
      );
    const files: CuratedSkill['files'] = [];
    let size = 0;
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error('Skill packages cannot contain symbolic links.');
        if (entry.isDirectory()) visit(target);
        else if (entry.isFile()) {
          size += fs.statSync(target).size;
          if (size > 10 * 1024 * 1024)
            throw new Error('Skill packages must be smaller than 10 MB.');
          const name = path.relative(folder, target);
          if (name !== 'SKILL.md' && /\.(md|txt|json|yaml|yml)$/i.test(name))
            files.push({ name, content: fs.readFileSync(target, 'utf8') });
        } else throw new Error('Unsupported skill package file.');
      }
    };
    visit(folder);
    return { id: name, name, description, markdown, files };
  }

  list(): CuratedSkill[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const skill = this.package(path.join(this.root, entry.name));
        if (skill.name !== entry.name)
          throw new Error('The skill name must match its library folder.');
        return skill;
      });
  }

  create(input: {
    name: string;
    description: string;
    instructions: string;
    files?: { name: string; content: string }[];
  }) {
    if (
      !input ||
      typeof input.name !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) ||
      input.name.length > 64 ||
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      typeof input.instructions !== 'string' ||
      !input.instructions.trim() ||
      input.instructions.length > 100000 ||
      input.description.length > 2000
    )
      throw new Error(
        'Provide a lowercase hyphenated name, description, and instructions.',
      );
    const files = input.files ?? [];
    if (
      !Array.isArray(files) ||
      files.length > 5 ||
      files.some(
        (file) =>
          !file ||
          typeof file.name !== 'string' ||
          !/^[a-z0-9][a-z0-9-]*\.md$/.test(file.name) ||
          file.name === 'skill.md' ||
          typeof file.content !== 'string' ||
          file.content.length > 20000,
      ) ||
      new Set(files.map((file) => file.name)).size !== files.length
    )
      throw new Error('Invalid skill supporting files.');
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(this.root, '.draft-'));
    try {
      fs.writeFileSync(
        path.join(temporary, 'SKILL.md'),
        `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.instructions}\n`,
      );
      for (const file of files)
        fs.writeFileSync(path.join(temporary, file.name), file.content);
      return this.import(temporary);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  import(folder: string) {
    const source = fs.realpathSync(folder);
    const skill = this.package(source);
    fs.mkdirSync(this.root, { recursive: true });
    const target = path.join(this.root, skill.name);
    if (fs.existsSync(target))
      throw new Error(
        'A skill with this name already exists. Edit it using Open skill folder.',
      );
    const temporary = fs.mkdtempSync(path.join(this.root, '.import-'));
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: false });
      this.package(temporary);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    return skill;
  }

  directory(id: string) {
    const skill = this.list().find((item) => item.id === id);
    if (!skill) throw new Error('Skill not found.');
    return path.join(this.root, skill.name);
  }

  runtimeSkills() {
    const skills = this.list();
    return {
      paths: skills.map((skill) => path.join(this.root, skill.name)),
      revision: createHash('sha256')
        .update(JSON.stringify(skills))
        .digest('hex'),
    };
  }
}
