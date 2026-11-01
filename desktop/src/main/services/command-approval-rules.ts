import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { CommandApprovalRule } from '../../shared/agent-execution';

// Deliberately accept only literal argv words. Shell syntax, wrappers, expansion,
// redirection, quotes and compound commands always require one-time approval.
export function commandWords(command: unknown): string[] | null {
  if (
    typeof command !== 'string' ||
    command.length > 10000 ||
    !/^[a-zA-Z0-9_./:@%+,= \t-]+$/.test(command)
  )
    return null;
  const words = command.trim().split(/[ \t]+/);
  return words[0] ? words : null;
}
export function commandPrefix(command: unknown): string[] | null {
  const words = commandWords(command);
  if (!words) return null;
  const [program, action, script] = words;
  if (
    ['git'].includes(program) &&
    [
      'status',
      'diff',
      'log',
      'show',
      'ls-files',
      'fetch',
      'add',
      'commit',
      'push',
    ].includes(action)
  )
    return words.slice(0, 2);
  if (['npm', 'pnpm', 'yarn'].includes(program)) {
    if (action === 'test') return words.slice(0, 2);
    if (action === 'run' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(script ?? ''))
      return words.slice(0, 3);
  }
  if (
    ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'pytest'].includes(
      program,
    )
  )
    return [program];
  return null;
}

export default class CommandApprovalRules {
  private readonly file: string;

  constructor(
    root: string,
    user: string,
    private readonly assertAccount: () => void = () => {},
  ) {
    this.file = path.join(
      root,
      'command-approvals',
      `${createHash('sha256').update(user).digest('hex')}.json`,
    );
  }

  private read(): CommandApprovalRule[] {
    this.assertAccount();
    try {
      const rules = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !Array.isArray(rules) ||
        rules.some(
          (rule) =>
            typeof rule.id !== 'string' ||
            typeof rule.directory !== 'string' ||
            !Array.isArray(rule.prefix) ||
            !rule.prefix.every((word: unknown) => typeof word === 'string') ||
            JSON.stringify(commandPrefix(rule.prefix.join(' '))) !==
              JSON.stringify(rule.prefix),
        )
      )
        throw new Error('Invalid saved command permissions.');
      return rules;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  private write(rules: CommandApprovalRule[]) {
    this.assertAccount();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(rules));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  list(directory: string) {
    const canonical = fs.realpathSync(directory);
    return this.read().filter((rule) => rule.directory === canonical);
  }

  matches(directory: string, command: unknown): boolean {
    const words = commandWords(command);
    if (!words || !commandPrefix(command)) return false;
    return this.list(directory).some((rule) =>
      rule.prefix.every((word, i) => words[i] === word),
    );
  }

  allow(directory: string, command: unknown) {
    const prefix = commandPrefix(command);
    if (!prefix) throw new Error('This command requires one-time approval.');
    const canonical = fs.realpathSync(directory);
    const rules = this.read();
    if (
      !rules.some(
        (rule) =>
          rule.directory === canonical &&
          JSON.stringify(rule.prefix) === JSON.stringify(prefix),
      )
    ) {
      rules.push({ id: randomUUID(), directory: canonical, prefix });
      this.write(rules);
    }
  }

  revoke(directory: string, id: string) {
    const canonical = fs.realpathSync(directory);
    this.write(
      this.read().filter(
        (rule) => !(rule.directory === canonical && rule.id === id),
      ),
    );
  }
}
