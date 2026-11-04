import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  FileAccess,
  WorkspacePermissionRule,
} from '../../shared/agent-execution';

/** Main-process, on-disk grants; never inferred from conversation history. */
export default class WorkspacePermissions {
  private readonly file: string;

  constructor(root: string, user = 'local') {
    this.file = path.join(
      root,
      'workspace-permissions',
      `${createHash('sha256').update(user).digest('hex')}.json`,
    );
  }

  private read(): WorkspacePermissionRule[] {
    try {
      const rules = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !Array.isArray(rules) ||
        rules.some(
          (rule) =>
            typeof rule.id !== 'string' ||
            typeof rule.directory !== 'string' ||
            !path.isAbsolute(rule.directory) ||
            !['workspace', 'path'].includes(rule.kind) ||
            (rule.kind === 'path' &&
              (!rule.fileAccess ||
                typeof rule.fileAccess.path !== 'string' ||
                !path.isAbsolute(rule.fileAccess.path) ||
                !['file', 'directory'].includes(rule.fileAccess.scope) ||
                !['read', 'write'].includes(rule.fileAccess.mode))),
        )
      ) {
        throw new Error('Invalid saved workspace permissions.');
      }
      return rules;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private write(rules: WorkspacePermissionRule[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(rules), {
      mode: 0o600,
    });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  list(directory: string) {
    const canonical = fs.realpathSync(directory);
    return this.read().filter((rule) => rule.directory === canonical);
  }

  hasWorkspace(directory: string) {
    return this.list(directory).some((rule) => rule.kind === 'workspace');
  }

  matches(directory: string, access: FileAccess) {
    return this.list(directory).some((rule) => {
      const grant = rule.fileAccess;
      if (
        rule.kind !== 'path' ||
        !grant ||
        (access.mode === 'write' && grant.mode !== 'write')
      )
        return false;
      if (grant.path === access.path)
        return grant.scope === 'directory' || access.scope === 'file';
      if (grant.scope !== 'directory') return false;
      const relative = path.relative(grant.path, access.path);
      return (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    });
  }

  allowWorkspace(directory: string) {
    this.allow(directory);
  }

  allow(directory: string, fileAccess?: FileAccess) {
    const canonical = fs.realpathSync(directory);
    const kind = fileAccess ? 'path' : 'workspace';
    const rules = this.read();
    if (
      rules.some(
        (rule) =>
          rule.directory === canonical &&
          rule.kind === kind &&
          JSON.stringify(rule.fileAccess) === JSON.stringify(fileAccess),
      )
    )
      return;
    rules.push({
      id: randomUUID(),
      directory: canonical,
      kind,
      ...(fileAccess ? { fileAccess: structuredClone(fileAccess) } : {}),
    });
    this.write(rules);
  }

  revoke(directory: string, id: string) {
    const canonical = fs.realpathSync(directory);
    this.write(
      this.read().filter(
        (rule) => rule.directory !== canonical || rule.id !== id,
      ),
    );
  }

  revokeWorkspace(directory: string) {
    const canonical = fs.realpathSync(directory);
    this.write(
      this.read().filter(
        (rule) => rule.directory !== canonical || rule.kind !== 'workspace',
      ),
    );
  }
}
