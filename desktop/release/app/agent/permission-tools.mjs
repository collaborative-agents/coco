import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  detectSupportedImageMimeTypeFromFile,
} from '@earendil-works/pi-coding-agent';

/** Resolve existing ancestors too, so new files cannot escape via symlinks. */
export function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling link is not a new file and must not be followed later.
    try {
      if (fs.lstatSync(target).isSymbolicLink())
        throw new Error('Permission denied: dangling symbolic link.');
    } catch (statError) {
      if (statError.code !== 'ENOENT') throw statError;
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(canonicalPath(parent), path.basename(target));
  }
}

export function workspacePath(cwd, input = '.') {
  if (typeof input !== 'string' || input.includes('\0'))
    throw new Error('Invalid file path.');
  let value = input
    .replace(/^@/, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (value === '~' || value.startsWith('~/'))
    value = path.join(os.homedir(), value.slice(1));
  const resolved = canonicalPath(path.resolve(cwd, value));
  const relative = path.relative(cwd, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      'Permission denied: path is outside the approved workspace. Choose that folder to grant access.',
    );
  return resolved;
}

export function createPermissionTools(cwd, requestApproval, skillPaths = []) {
  const readableSkills = skillPaths.map((root) => fs.realpathSync(root));
  const check = (target) => workspacePath(cwd, target);
  const checkRead = (target) => {
    for (const root of readableSkills) {
      try {
        return workspacePath(root, path.resolve(cwd, target));
      } catch {
        /* Try the workspace next. */
      }
    }
    return check(target);
  };
  const readFile = async (target) => fs.promises.readFile(check(target));
  const writeFile = async (target, content) =>
    fs.promises.writeFile(check(target), content);
  const access = async (target) => fs.promises.access(check(target));
  const tools = [
    createReadTool(cwd, {
      operations: {
        readFile: async (target) => fs.promises.readFile(checkRead(target)),
        access: async (target) => fs.promises.access(checkRead(target)),
        detectImageMimeType: (target) =>
          detectSupportedImageMimeTypeFromFile(checkRead(target)),
      },
    }),
    createWriteTool(cwd, {
      operations: {
        writeFile,
        mkdir: async (target) => {
          await fs.promises.mkdir(check(target), { recursive: true });
        },
      },
    }),
    createEditTool(cwd, { operations: { readFile, writeFile, access } }),
    // These SDK searches do not follow directory symlinks. Explicit roots are
    // checked below; grep's context-file reads are checked again at use time.
    createGrepTool(cwd, {
      operations: {
        isDirectory: (target) => fs.statSync(check(target)).isDirectory(),
        readFile: (target) => fs.readFileSync(check(target), 'utf8'),
      },
    }),
    createFindTool(cwd),
    createLsTool(cwd, {
      operations: {
        exists: (target) => fs.existsSync(check(target)),
        stat: (target) => fs.promises.stat(check(target)),
        readdir: (target) => fs.promises.readdir(check(target)),
      },
    }),
  ];
  return [
    ...tools.map((tool) => ({
      ...tool,
      execute(id, args, signal, update) {
        if (signal?.aborted) throw new Error('Operation aborted');
        const checkTarget = tool.name === 'read' ? checkRead : check;
        const target = checkTarget(args.path ?? '.');
        // SDK tools normalize paths again. Refuse aliases whose normalization
        // changes a canonical path (for example a directory with Unicode spaces).
        if (checkTarget(target) !== target)
          throw new Error('Permission denied: ambiguous normalized path.');
        return tool.execute(id, { ...args, path: target }, signal, update);
      },
    })),
    requireApproval(createBashTool(cwd), cwd, requestApproval),
  ];
}

export function requireApproval(tool, cwd, requestApproval) {
  return {
    ...tool,
    async execute(id, args, signal, update) {
      // Snapshot the exact arguments before waiting; approvals cannot authorize
      // a later mutation of the original tool call.
      const approvedArgs = structuredClone(args);
      if (signal?.aborted) throw new Error('Operation aborted');
      const allowed = await requestApproval?.(
        {
          toolCallId: id,
          tool: tool.name,
          arguments: structuredClone(approvedArgs),
          directory: cwd,
        },
        signal,
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      if (allowed !== true)
        throw new Error(
          'Permission denied by user. Do not retry this action through another tool.',
        );
      return tool.execute(id, approvedArgs, signal, update);
    },
  };
}
