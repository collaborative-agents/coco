import { readHarnessVersion } from '../main/services/harness-version';

const ENV_KEYS = [
  'COCO_GIT_COMMIT_SHA',
  'COCO_GIT_BRANCH',
  'COCO_GIT_REPOSITORY',
  'COCO_GIT_DIRTY',
] as const;

describe('readHarnessVersion', () => {
  const savedEnvironment = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    ENV_KEYS.forEach((key) => delete process.env[key]);
  });

  afterAll(() => {
    ENV_KEYS.forEach((key) => {
      const value = savedEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  it('reads the checkout and normalizes a GitHub remote', () => {
    const values: Record<string, string> = {
      'rev-parse HEAD': 'abc123',
      'symbolic-ref --short HEAD': 'sensing-growth',
      'remote get-url origin':
        'git@github.com:collaborative-agents/monorepo.git',
      'status --porcelain': ' M desktop/src/main/main.ts',
    };

    expect(readHarnessVersion((args) => values[args.join(' ')])).toEqual({
      gitCommitSha: 'abc123',
      gitBranch: 'sensing-growth',
      repository: 'collaborative-agents/monorepo',
      gitDirty: true,
    });
  });

  it('uses environment metadata when a packaged build has no checkout', () => {
    process.env.COCO_GIT_COMMIT_SHA = 'def456';
    process.env.COCO_GIT_BRANCH = 'pilot-release';
    process.env.COCO_GIT_REPOSITORY = 'collaborative-agents/monorepo';
    process.env.COCO_GIT_DIRTY = 'false';

    expect(readHarnessVersion(() => undefined)).toEqual({
      gitCommitSha: 'def456',
      gitBranch: 'pilot-release',
      repository: 'collaborative-agents/monorepo',
      gitDirty: false,
    });
  });

  it('uses metadata embedded by each production build without a checkout', () => {
    expect(
      readHarnessVersion(() => undefined, {
        gitCommitSha: 'build-sha',
        gitBranch: 'sensing-growth',
        repository: 'collaborative-agents/monorepo',
        gitDirty: false,
      }),
    ).toEqual({
      gitCommitSha: 'build-sha',
      gitBranch: 'sensing-growth',
      repository: 'collaborative-agents/monorepo',
      gitDirty: false,
    });
  });

  it('allows explicit runtime metadata to override embedded build metadata', () => {
    process.env.COCO_GIT_COMMIT_SHA = 'runtime-sha';

    expect(
      readHarnessVersion(() => undefined, {
        gitCommitSha: 'build-sha',
        gitBranch: 'sensing-growth',
      }),
    ).toEqual({
      gitCommitSha: 'runtime-sha',
      gitBranch: 'sensing-growth',
    });
  });
});
