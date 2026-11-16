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

function resolveInput(cwd, input = '.') {
  if (typeof input !== 'string' || input.includes('\0'))
    throw new Error('Invalid file path.');
  let value = input
    .replace(/^@/, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (value === '~' || value.startsWith('~/'))
    value = path.join(os.homedir(), value.slice(1));
  const resolved = canonicalPath(path.resolve(cwd, value));
  return resolved;
}

export function workspacePath(cwd, input = '.') {
  const resolved = resolveInput(cwd, input);
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

export function createPermissionTools(
  cwd,
  requestApproval,
  skillPaths = [],
  requestWorkspaceAccess,
) {
  const readableSkills = skillPaths.map((root) => fs.realpathSync(root));
  const within = (root, target) => {
    const relative = path.relative(root, target);
    return (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const implicit = (target, mode) =>
    within(cwd, target) ||
    (mode === 'read' && readableSkills.some((root) => within(root, target)));

  // Each invocation receives its own scope. A one-time grant never leaks to
  // concurrent tools, later calls, sibling files, or another chat.
  const build = (check, checkRead, mkdir) => [
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
        writeFile: async (target, content) =>
          fs.promises.writeFile(check(target), content),
        mkdir,
      },
    }),
    createEditTool(cwd, {
      operations: {
        readFile: async (target) => fs.promises.readFile(check(target)),
        writeFile: async (target, content) =>
          fs.promises.writeFile(check(target), content),
        access: async (target) => fs.promises.access(check(target)),
      },
    }),
    // The SDK searches do not follow directory symlinks. Context reads are
    // checked again at use time, including paths discovered by grep.
    createGrepTool(cwd, {
      operations: {
        isDirectory: (target) => fs.statSync(checkRead(target)).isDirectory(),
        readFile: (target) => fs.readFileSync(checkRead(target), 'utf8'),
      },
    }),
    createFindTool(cwd),
    createLsTool(cwd, {
      operations: {
        exists: (target) => fs.existsSync(checkRead(target)),
        stat: (target) => fs.promises.stat(checkRead(target)),
        readdir: (target) => fs.promises.readdir(checkRead(target)),
      },
    }),
  ];
  const unavailable = () => {
    throw new Error('Permission scope has not been established.');
  };
  return [
    ...build(unavailable, unavailable, unavailable).map((tool) => ({
      ...tool,
      async execute(id, args, signal, update) {
        if (signal?.aborted) throw new Error('Operation aborted');
        const approvedArgs = structuredClone(args);
        const target = resolveInput(cwd, approvedArgs.path ?? '.');
        if (resolveInput(cwd, target) !== target)
          throw new Error('Permission denied: ambiguous normalized path.');
        const mode = ['write', 'edit'].includes(tool.name) ? 'write' : 'read';
        if (within(cwd, target) && requestWorkspaceAccess) {
          const allowed = await requestWorkspaceAccess(signal);
          if (signal?.aborted) throw new Error('Operation aborted');
          if (allowed !== true)
            throw new Error(
              'Permission denied by user. Do not retry this action through another tool.',
            );
        }

        let grant;
        if (!implicit(target, mode)) {
          let scope = ['ls', 'find'].includes(tool.name) ? 'directory' : 'file';
          try {
            scope = fs.statSync(target).isDirectory() ? 'directory' : 'file';
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const fileAccess = { path: target, mode, scope };
          const allowed = await requestApproval?.(
            {
              toolCallId: id,
              tool: tool.name,
              directory: cwd,
              arguments: { ...structuredClone(approvedArgs), path: target },
              fileAccess: structuredClone(fileAccess),
            },
            signal,
          );
          if (signal?.aborted) throw new Error('Operation aborted');
          if (allowed !== true)
            throw new Error(
              'Permission denied by user. Do not retry this action through another tool.',
            );
          grant = fileAccess;
        }
        if (resolveInput(cwd, approvedArgs.path ?? '.') !== target)
          throw new Error(
            'Permission denied: path changed while waiting for approval.',
          );
        const checked = (input, operationMode) => {
          const resolved = resolveInput(cwd, input);
          if (
            implicit(resolved, operationMode) ||
            (grant &&
              (grant.mode === 'write' || operationMode === 'read') &&
              (resolved === grant.path ||
                (grant.scope === 'directory' && within(grant.path, resolved))))
          )
            return resolved;
          throw new Error(
            'Permission denied: path is outside the approved scope.',
          );
        };
        const tools = build(
          (input) => checked(input, 'write'),
          (input) => checked(input, 'read'),
          async (input) => {
            const resolved = resolveInput(cwd, input);
            // write creates only the requested file's parents, not a reusable
            // permission to write siblings in the containing directory.
            if (tool.name !== 'write' || resolved !== path.dirname(target))
              throw new Error(
                'Permission denied: unexpected parent directory.',
              );
            checked(target, 'write');
            await fs.promises.mkdir(resolved, { recursive: true });
          },
        );
        return tools
          .find((candidate) => candidate.name === tool.name)
          .execute(id, { ...approvedArgs, path: target }, signal, update);
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
