import { execFileSync } from 'child_process';

export interface HarnessVersion {
  gitCommitSha?: string;
  gitBranch?: string;
  repository?: string;
  gitDirty?: boolean;
}

// Replaced with a JSON literal by the production main-process webpack build.
// `typeof` keeps this module executable in development and Jest, where the
// compile-time constant does not exist.
declare const __COCO_BUILD_HARNESS_VERSION__: HarnessVersion | undefined;

type GitRunner = (args: string[]) => string | undefined;

function runGit(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function normalizeRepository(remote: string | undefined): string | undefined {
  const value = remote?.trim();
  if (!value) return undefined;
  const githubMatch = value.match(
    /github\.com(?:[/:])([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  return githubMatch?.[1] ?? value;
}

function parseDirty(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return undefined;
}

/** Resolve the code version that controls prompts, context, and model tools. */
export function readHarnessVersion(
  git: GitRunner = runGit,
  embeddedVersion: HarnessVersion = typeof __COCO_BUILD_HARNESS_VERSION__ ===
  'undefined'
    ? {}
    : __COCO_BUILD_HARNESS_VERSION__,
): HarnessVersion {
  const gitCommitSha =
    process.env.COCO_GIT_COMMIT_SHA?.trim() ||
    embeddedVersion.gitCommitSha ||
    git(['rev-parse', 'HEAD']);
  const gitBranch =
    process.env.COCO_GIT_BRANCH?.trim() ||
    embeddedVersion.gitBranch ||
    git(['symbolic-ref', '--short', 'HEAD']);
  const repository = normalizeRepository(
    process.env.COCO_GIT_REPOSITORY?.trim() ||
      embeddedVersion.repository ||
      git(['remote', 'get-url', 'origin']),
  );
  const configuredDirty = parseDirty(process.env.COCO_GIT_DIRTY);
  const status =
    configuredDirty === undefined && embeddedVersion.gitDirty === undefined
      ? git(['status', '--porcelain'])
      : undefined;
  const gitDirty =
    configuredDirty ??
    embeddedVersion.gitDirty ??
    (status === undefined ? undefined : status.length > 0);

  return {
    ...(gitCommitSha ? { gitCommitSha } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(repository ? { repository } : {}),
    ...(gitDirty !== undefined ? { gitDirty } : {}),
  };
}
