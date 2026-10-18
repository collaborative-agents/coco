import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  boundedCaptureSize,
  encodeCaptureJpeg,
  physicalDisplaySize,
  PostAssessmentActivityRecorder,
} from './post-assessment-recorder';

it('requests the physical backing resolution for Retina displays', () => {
  expect(
    physicalDisplaySize({
      size: { width: 1728, height: 1117 },
      scaleFactor: 2,
    }),
  ).toEqual({ width: 3456, height: 2234 });
  expect(
    physicalDisplaySize({
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    }),
  ).toEqual({ width: 1920, height: 1080 });
});

it('reduces difficult captures until they fit the per-image budget', () => {
  type TestImage = Parameters<typeof encodeCaptureJpeg>[0];
  const image = (width: number, height: number): TestImage => ({
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }) => {
      const scale = nextWidth
        ? nextWidth / width
        : (nextHeight as number) / height;
      return image(
        nextWidth ?? Math.round(width * scale),
        nextHeight ?? Math.round(height * scale),
      );
    },
    toJPEG: () => Buffer.alloc(Math.ceil((width * height) / 10)),
  });

  expect(encodeCaptureJpeg(image(3456, 2234)).length).toBeLessThanOrEqual(
    150 * 1024,
  );
});

it('bounds Retina captures while preserving their aspect ratio', () => {
  expect(
    boundedCaptureSize({
      size: { width: 1728, height: 1117 },
      scaleFactor: 2,
    }),
  ).toEqual({ width: 2560, height: 1655 });
  expect(
    boundedCaptureSize({
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    }),
  ).toEqual({ width: 1920, height: 1080 });
  expect(
    boundedCaptureSize({
      size: { width: 1080, height: 1920 },
      scaleFactor: 2,
    }),
  ).toEqual({ width: 1440, height: 2560 });
});

describe('PostAssessmentActivityRecorder', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'coco-task-recorder-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function recorder(overrides: Record<string, unknown> = {}) {
    let now = Date.parse('2026-10-07T12:00:01Z');
    return new PostAssessmentActivityRecorder({
      recordsRoot: () => root,
      captureScreen: async () => ({
        jpeg: Buffer.from('jpeg-image'),
        sourceName: 'Primary display',
      }),
      activeApplication: async () => 'Safari',
      readConversations: () => [
        {
          sessionId: 'conversation-1',
          title: 'Budget analysis',
          problem: 'Budget analysis',
          createdAt: Date.parse('2026-10-07T12:00:02Z'),
          updatedAt: Date.parse('2026-10-07T12:00:03Z'),
          messages: [
            {
              role: 'user',
              text: 'Compare the draft plans.',
              ts: Date.parse('2026-10-07T12:00:02Z'),
            },
            {
              role: 'tutor',
              text: 'Verify every saving against the source files.',
              ts: Date.parse('2026-10-07T12:00:03Z'),
            },
          ],
        },
      ],
      readActivity: () => [
        {
          ts: Date.parse('2026-10-07T12:00:02Z') / 1000,
          status: 'discernment_opportunity',
          observation: 'The participant is checking an AI claim.',
        },
      ],
      now: () => {
        const value = new Date(now);
        now += 1000;
        return value;
      },
      intervalMs: 60 * 60 * 1000,
      ...overrides,
    });
  }

  it('records, restores, reviews, and automatically builds the activity log', async () => {
    const startedAt = '2026-10-07T12:00:00Z';
    const first = recorder();
    await expect(first.begin(startedAt)).resolves.toMatchObject({
      status: 'recording',
      capture_count: 1,
      can_generate_log: true,
    });
    const captures = await first.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      application: 'Safari',
      source_name: 'Primary display',
    });
    expect(captures[0].image_data_url).toContain('data:image/jpeg;base64,');
    await expect(first.captureNow()).resolves.toMatchObject({
      capture_count: 1,
    });
    await first.pause();

    const restored = recorder();
    await expect(restored.restore(startedAt)).resolves.toMatchObject({
      status: 'paused',
      capture_count: 1,
    });
    const log = await restored.buildAutomaticLog();
    expect(log?.filename).toBe('post-assessment-activity-log.html');
    expect(log?.data.toString()).toContain('Compare the draft plans.');
    expect(log?.data.toString()).toContain(
      'The participant is checking an AI claim.',
    );
    expect(log?.data.toString()).toContain('data:image/jpeg;base64,');

    await expect(restored.removeCapture(captures[0].id)).resolves.toMatchObject(
      {
        capture_count: 0,
      },
    );
    await restored.completeAndDelete();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('excludes conversations and activity created while recording is paused', async () => {
    const startedAt = '2026-10-07T12:00:00Z';
    const paused = recorder({
      readConversations: () => [
        {
          sessionId: 'conversation-1',
          title: 'Budget analysis',
          problem: 'Budget analysis',
          createdAt: Date.parse('2026-10-07T12:00:02Z'),
          updatedAt: Date.parse('2026-10-07T12:00:04Z'),
          messages: [
            {
              role: 'user',
              text: 'Visible before pause',
              ts: Date.parse('2026-10-07T12:00:02Z'),
            },
            {
              role: 'user',
              text: 'Private during pause',
              ts: Date.parse('2026-10-07T12:00:04Z'),
            },
          ],
        },
      ],
      readActivity: () => [
        {
          ts: Date.parse('2026-10-07T12:00:04Z') / 1000,
          status: 'irrelevant',
          observation: 'Private paused activity',
        },
      ],
    });

    await paused.begin(startedAt);
    await paused.pause();
    const log = await paused.buildAutomaticLog();

    expect(log?.data.toString()).toContain('Visible before pause');
    expect(log?.data.toString()).not.toContain('Private during pause');
    expect(log?.data.toString()).not.toContain('Private paused activity');
  });

  it('reports when required task recording is unavailable', async () => {
    const startedAt = '2026-10-07T12:00:00Z';
    const unavailable = recorder({
      captureScreen: async () => {
        throw new Error('Screen recording permission is unavailable.');
      },
    });
    await expect(unavailable.begin(startedAt)).resolves.toMatchObject({
      status: 'unavailable',
      can_generate_log: false,
      last_error: 'Screen recording permission is unavailable.',
    });
  });
});
