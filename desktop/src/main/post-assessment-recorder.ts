import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { app, desktopCapturer, screen } from 'electron';
import { readActivity } from './activity-store';
import {
  readConversations,
  type StoredConversation,
} from './conversation-store';
import type {
  TaskRecorderCapture,
  TaskRecorderState,
  TaskRecorderStatus,
} from '../shared/post-assessment';
import type { ActivityRecord } from '../renderer/components/observation-types';

const CAPTURE_INTERVAL_MS = 30_000;
// The immediate first capture plus 299 interval captures covers just under
// 2.5 hours. The following tick pauses recording at the 2.5-hour mark.
const MAX_CAPTURES = 300;
// Embedded JPEGs expand by roughly one-third when base64 encoded in the HTML.
// Bounding every JPEG keeps the complete capture set below this local limit.
const MAX_CAPTURE_BYTES = 45 * 1024 * 1024;
const MAX_CAPTURE_JPEG_BYTES = 150 * 1024;
const MAX_LOG_BYTES = 62 * 1024 * 1024;
// The activity log displays captures at no more than 1000 CSS pixels wide.
// Keeping a 2560-pixel source retains enough detail for zooming and Retina
// review without spending most of the upload budget on unused pixels.
const MAX_CAPTURE_DIMENSION = 2560;
const CAPTURE_JPEG_QUALITY = 65;

interface StoredCapture {
  id: string;
  captured_at: string;
  application: string | null;
  source_name: string;
  filename: string;
  size: number;
  sha256?: string;
}

interface RecorderEvent {
  type: 'started' | 'paused' | 'resumed';
  at: string;
}

interface RecorderManifest {
  version: 1;
  started_at: string;
  consented_at: string | null;
  status: TaskRecorderStatus;
  captures: StoredCapture[];
  events: RecorderEvent[];
  last_error: string | null;
}

interface CaptureResult {
  jpeg: Buffer;
  sourceName: string;
}

interface JpegEncodableImage {
  getSize(): { width: number; height: number };
  resize(options: {
    width?: number;
    height?: number;
    quality?: 'good' | 'better' | 'best';
  }): JpegEncodableImage;
  toJPEG(quality: number): Buffer;
}

interface RecordedInterval {
  start: number;
  end: number;
}

export function physicalDisplaySize(display: {
  size: { width: number; height: number };
  scaleFactor: number;
}): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
  };
}

export function boundedCaptureSize(display: {
  size: { width: number; height: number };
  scaleFactor: number;
}): { width: number; height: number } {
  const physical = physicalDisplaySize(display);
  const largestDimension = Math.max(physical.width, physical.height);
  if (largestDimension <= MAX_CAPTURE_DIMENSION) return physical;
  const scale = MAX_CAPTURE_DIMENSION / largestDimension;
  return {
    width: Math.max(1, Math.round(physical.width * scale)),
    height: Math.max(1, Math.round(physical.height * scale)),
  };
}

function resizedToFit(
  image: JpegEncodableImage,
  maxDimension: number,
): JpegEncodableImage {
  const size = image.getSize();
  if (Math.max(size.width, size.height) <= maxDimension) return image;
  return size.width >= size.height
    ? image.resize({ width: maxDimension, quality: 'best' })
    : image.resize({ height: maxDimension, quality: 'best' });
}

export function encodeCaptureJpeg(image: JpegEncodableImage): Buffer {
  const attempts = [
    { maxDimension: 2560, quality: CAPTURE_JPEG_QUALITY },
    { maxDimension: 2304, quality: CAPTURE_JPEG_QUALITY },
    { maxDimension: 2048, quality: CAPTURE_JPEG_QUALITY },
    { maxDimension: 1792, quality: 60 },
    { maxDimension: 1600, quality: 55 },
    { maxDimension: 1440, quality: 50 },
    { maxDimension: 1280, quality: 45 },
    { maxDimension: 1024, quality: 40 },
    { maxDimension: 768, quality: 35 },
    { maxDimension: 512, quality: 30 },
  ];
  let smallest: Buffer | null = null;
  let bounded: Buffer | null = null;
  attempts.some((attempt) => {
    const jpeg = resizedToFit(image, attempt.maxDimension).toJPEG(
      attempt.quality,
    );
    if (!smallest || jpeg.length < smallest.length) smallest = jpeg;
    if (jpeg.length > MAX_CAPTURE_JPEG_BYTES) return false;
    bounded = jpeg;
    return true;
  });
  if (bounded) return bounded;

  // Extremely noisy screen content can compress poorly. Continue reducing the
  // fallback until the byte ceiling is met, guaranteeing the duration budget.
  const encodeFallback = (maxDimension: number): Buffer => {
    const jpeg = resizedToFit(image, maxDimension).toJPEG(25);
    if (!smallest || jpeg.length < smallest.length) smallest = jpeg;
    if (jpeg.length <= MAX_CAPTURE_JPEG_BYTES) return jpeg;
    if (maxDimension <= 64) return smallest!;
    return encodeFallback(Math.max(64, Math.floor(maxDimension / 2)));
  };
  return encodeFallback(384);
}

export interface TaskRecorderDependencies {
  recordsRoot: () => string;
  captureScreen: () => Promise<CaptureResult>;
  activeApplication: () => Promise<string | null>;
  readConversations: () => StoredConversation[];
  readActivity: (sinceTs: number) => ActivityRecord[];
  now?: () => Date;
  intervalMs?: number;
}

function safeStartedAt(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()))
    throw new Error('The execution task has an invalid start time.');
  return date.toISOString();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function recordedIntervals(
  manifest: RecorderManifest,
  generatedAt: string,
): RecordedInterval[] {
  const intervals: RecordedInterval[] = [];
  let activeStart: number | null = null;
  manifest.events.forEach((event) => {
    const eventTime = new Date(event.at).getTime();
    if (!Number.isFinite(eventTime)) return;
    if (event.type === 'started' || event.type === 'resumed') {
      if (activeStart === null) activeStart = eventTime;
      return;
    }
    if (activeStart !== null) {
      intervals.push({ start: activeStart, end: eventTime });
      activeStart = null;
    }
  });
  if (activeStart !== null && manifest.status === 'recording') {
    intervals.push({
      start: activeStart,
      end: new Date(generatedAt).getTime(),
    });
  }
  return intervals;
}

function fallsWithinRecordedInterval(
  timestamp: number,
  intervals: RecordedInterval[],
): boolean {
  return intervals.some(
    (interval) => timestamp >= interval.start && timestamp <= interval.end,
  );
}

function publicState(manifest: RecorderManifest | null): TaskRecorderState {
  if (!manifest) {
    return {
      status: 'inactive',
      started_at: null,
      capture_count: 0,
      can_generate_log: false,
      last_error: null,
    };
  }
  const canGenerate = ['recording', 'paused'].includes(manifest.status);
  return {
    status: manifest.status,
    started_at: manifest.started_at,
    capture_count: manifest.captures.length,
    can_generate_log: canGenerate,
    last_error: manifest.last_error,
  };
}

export class PostAssessmentActivityRecorder {
  private readonly dependencies: TaskRecorderDependencies;

  private manifest: RecorderManifest | null = null;

  private sessionDirectory: string | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  private captureInProgress = false;

  constructor(dependencies: TaskRecorderDependencies) {
    this.dependencies = dependencies;
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private directoryFor(startedAt: string): string {
    return path.join(
      this.dependencies.recordsRoot(),
      `execution-${new Date(startedAt).getTime()}`,
    );
  }

  private manifestPath(): string {
    if (!this.sessionDirectory) throw new Error('No task recording is active.');
    return path.join(this.sessionDirectory, 'manifest.json');
  }

  private async save(): Promise<void> {
    if (!this.manifest || !this.sessionDirectory) return;
    await fs.mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    const destination = this.manifestPath();
    const temporary = `${destination}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(this.manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(temporary, destination);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startTimer(): void {
    this.stopTimer();
    const interval = this.dependencies.intervalMs ?? CAPTURE_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.captureNow().catch(() => undefined);
    }, interval);
    this.timer.unref?.();
  }

  async restore(startedAt: string | null): Promise<TaskRecorderState> {
    if (!startedAt) return publicState(null);
    const normalized = safeStartedAt(startedAt);
    if (this.manifest?.started_at === normalized)
      return publicState(this.manifest);
    this.stopTimer();
    this.sessionDirectory = this.directoryFor(normalized);
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.manifestPath(), 'utf8'),
      ) as RecorderManifest;
      if (parsed.version !== 1 || parsed.started_at !== normalized)
        throw new Error('Invalid task recording metadata.');
      this.manifest = parsed;
      if (parsed.status === 'recording') this.startTimer();
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      this.manifest = null;
    }
    return publicState(this.manifest);
  }

  async begin(startedAt: string): Promise<TaskRecorderState> {
    const normalized = safeStartedAt(startedAt);
    this.stopTimer();
    this.sessionDirectory = this.directoryFor(normalized);
    const now = this.now().toISOString();
    this.manifest = {
      version: 1,
      started_at: normalized,
      consented_at: now,
      status: 'recording',
      captures: [],
      events: [{ type: 'started', at: now }],
      last_error: null,
    };
    await this.save();
    try {
      await this.captureNow();
      this.startTimer();
    } catch (error) {
      this.manifest.status = 'unavailable';
      this.manifest.last_error =
        error instanceof Error ? error.message : String(error);
      await this.save();
    }
    return publicState(this.manifest);
  }

  async captureNow(): Promise<TaskRecorderState> {
    if (
      !this.manifest ||
      this.manifest.status !== 'recording' ||
      this.captureInProgress
    )
      return publicState(this.manifest);
    if (this.manifest.captures.length >= MAX_CAPTURES) {
      await this.pause(
        'Recording paused after reaching 300 captures (about 2.5 hours).',
      );
      return publicState(this.manifest);
    }
    const usedBytes = this.manifest.captures.reduce(
      (total, capture) => total + capture.size,
      0,
    );
    if (usedBytes >= MAX_CAPTURE_BYTES) {
      await this.pause(
        'Recording paused after reaching the 45 MiB local limit.',
      );
      return publicState(this.manifest);
    }
    this.captureInProgress = true;
    try {
      const [capture, application] = await Promise.all([
        this.dependencies.captureScreen(),
        this.dependencies.activeApplication().catch(() => null),
      ]);
      if (!capture.jpeg.length)
        throw new Error('Screen capture returned no image.');
      const digest = createHash('sha256').update(capture.jpeg).digest('hex');
      if (
        this.manifest.captures[this.manifest.captures.length - 1]?.sha256 ===
        digest
      )
        return publicState(this.manifest);
      if (usedBytes + capture.jpeg.length > MAX_CAPTURE_BYTES) {
        await this.pause(
          'Recording paused before exceeding the 45 MiB local limit.',
        );
        return publicState(this.manifest);
      }
      const capturedAt = this.now().toISOString();
      const id = `${new Date(capturedAt).getTime()}-${this.manifest.captures.length + 1}`;
      const filename = `${id}.jpg`;
      await fs.writeFile(
        path.join(this.sessionDirectory!, filename),
        capture.jpeg,
        {
          mode: 0o600,
        },
      );
      this.manifest.captures.push({
        id,
        captured_at: capturedAt,
        application,
        source_name: capture.sourceName,
        filename,
        size: capture.jpeg.length,
        sha256: digest,
      });
      this.manifest.last_error = null;
      await this.save();
      return publicState(this.manifest);
    } catch (error) {
      this.manifest.last_error =
        error instanceof Error ? error.message : String(error);
      await this.save();
      throw error;
    } finally {
      this.captureInProgress = false;
    }
  }

  async pause(reason?: string): Promise<TaskRecorderState> {
    if (!this.manifest || this.manifest.status !== 'recording')
      return publicState(this.manifest);
    this.stopTimer();
    this.manifest.status = 'paused';
    this.manifest.last_error = reason ?? null;
    this.manifest.events.push({ type: 'paused', at: this.now().toISOString() });
    await this.save();
    return publicState(this.manifest);
  }

  async resume(): Promise<TaskRecorderState> {
    if (!this.manifest || this.manifest.status !== 'paused')
      return publicState(this.manifest);
    this.manifest.status = 'recording';
    this.manifest.last_error = null;
    this.manifest.events.push({
      type: 'resumed',
      at: this.now().toISOString(),
    });
    await this.save();
    try {
      await this.captureNow();
      this.startTimer();
    } catch (error) {
      this.manifest.status = 'unavailable';
      this.manifest.last_error =
        error instanceof Error ? error.message : String(error);
      await this.save();
    }
    return publicState(this.manifest);
  }

  async captures(): Promise<TaskRecorderCapture[]> {
    if (!this.manifest || !this.sessionDirectory) return [];
    const directory = this.sessionDirectory;
    const captures = await Promise.all(
      this.manifest.captures.map(
        async (capture): Promise<TaskRecorderCapture | null> => {
          try {
            const data = await fs.readFile(
              path.join(directory, capture.filename),
            );
            return {
              id: capture.id,
              captured_at: capture.captured_at,
              application: capture.application,
              source_name: capture.source_name,
              image_data_url: `data:image/jpeg;base64,${data.toString('base64')}`,
            };
          } catch {
            // A missing capture should not hide the rest of the review timeline.
            return null;
          }
        },
      ),
    );
    return captures.filter(
      (capture): capture is TaskRecorderCapture => capture !== null,
    );
  }

  async removeCapture(id: string): Promise<TaskRecorderState> {
    if (!this.manifest || !this.sessionDirectory)
      return publicState(this.manifest);
    const capture = this.manifest.captures.find((item) => item.id === id);
    if (!capture) throw new Error('That task capture no longer exists.');
    await fs.rm(path.join(this.sessionDirectory, capture.filename), {
      force: true,
    });
    this.manifest.captures = this.manifest.captures.filter(
      (item) => item.id !== id,
    );
    await this.save();
    return publicState(this.manifest);
  }

  async buildAutomaticLog(): Promise<{
    filename: string;
    data: Buffer;
  } | null> {
    if (
      !this.manifest ||
      !this.sessionDirectory ||
      !['recording', 'paused'].includes(this.manifest.status)
    )
      return null;
    if (this.manifest.status === 'recording') {
      try {
        await this.captureNow();
      } catch (error) {
        this.manifest.last_error =
          error instanceof Error ? error.message : String(error);
        await this.save();
      }
    }
    const startedMs = new Date(this.manifest.started_at).getTime();
    const generatedAt = this.now().toISOString();
    const intervals = recordedIntervals(this.manifest, generatedAt);
    const conversations = this.dependencies
      .readConversations()
      .map((conversation) => ({
        ...conversation,
        messages: conversation.messages.filter(
          (message) =>
            typeof message.ts === 'number' &&
            message.ts >= startedMs &&
            fallsWithinRecordedInterval(message.ts, intervals),
        ),
      }))
      .filter((conversation) => conversation.messages.length > 0);
    const activities = this.dependencies
      .readActivity(startedMs / 1000)
      .filter((activity) =>
        fallsWithinRecordedInterval(activity.ts * 1000, intervals),
      );
    const captures = await this.captures();
    const captureRows = captures
      .map(
        (capture) => `<article class="capture">
          <h3>${escapeHtml(new Date(capture.captured_at).toLocaleString())}</h3>
          <p>Application: ${escapeHtml(capture.application ?? 'Unavailable')} · Display: ${escapeHtml(capture.source_name)}</p>
          <img src="${capture.image_data_url}" alt="Task activity capture at ${escapeHtml(capture.captured_at)}">
        </article>`,
      )
      .join('\n');
    const conversationRows = conversations
      .map((conversation) => {
        const messages = conversation.messages
          .map(
            (message) => `<div class="message ${message.role}">
              <strong>${message.role === 'user' ? 'Participant' : 'Coco'}</strong>
              <pre>${escapeHtml(message.text)}</pre>
            </div>`,
          )
          .join('\n');
        return `<article><h3>${escapeHtml(conversation.title ?? conversation.problem)}</h3>${messages || '<p>No timestamped messages were available.</p>'}</article>`;
      })
      .join('\n');
    const activityRows = activities
      .map(
        (activity) =>
          `<tr><td>${escapeHtml(new Date(activity.ts * 1000).toLocaleString())}</td><td>${escapeHtml(activity.status)}</td><td>${escapeHtml(activity.observation ?? '')}</td></tr>`,
      )
      .join('\n');
    const eventRows = this.manifest.events
      .map(
        (event) =>
          `<li>${escapeHtml(new Date(event.at).toLocaleString())}: ${escapeHtml(event.type)}</li>`,
      )
      .join('\n');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Post-assessment activity log</title>
<style>
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211c;max-width:1000px;margin:32px auto;padding:0 24px}h1,h2{color:#123d2b}.notice{background:#f1f7f3;border:1px solid #bdd8c8;padding:12px;border-radius:8px}.capture,.message,article{break-inside:avoid;border-top:1px solid #d8e2dc;padding:16px 0}.capture img{display:block;max-width:100%;height:auto;border:1px solid #cad5ce;border-radius:6px}.message{padding:10px}.message.user{background:#f6f8f7}.message.tutor{background:#eef6ff}pre{white-space:pre-wrap;word-break:break-word;font:inherit}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d8e2dc;padding:8px;text-align:left;vertical-align:top}td:first-child{white-space:nowrap}</style></head>
<body><h1>Post-assessment task activity log</h1>
<p class="notice">Generated automatically by Coco Learn after the participant was informed that this task session would be recorded. It includes periodic task screenshots, application names when available, Coco conversations, and semantic activity events from recording intervals. Paused intervals are excluded. It does not contain raw keystrokes, audio, or a guaranteed complete transcript from external AI tools.</p>
<dl><dt>Task started</dt><dd>${escapeHtml(new Date(this.manifest.started_at).toLocaleString())}</dd><dt>Log generated</dt><dd>${escapeHtml(new Date(generatedAt).toLocaleString())}</dd><dt>Captures retained</dt><dd>${captures.length}</dd></dl>
<h2>Recording events</h2><ul>${eventRows || '<li>No events recorded.</li>'}</ul>
<h2>Coco conversations</h2>${conversationRows || '<p>No Coco conversations were recorded during this task.</p>'}
<h2>Activity timeline</h2><table><thead><tr><th>Time</th><th>Status</th><th>Observation</th></tr></thead><tbody>${activityRows || '<tr><td colspan="3">No semantic activity events were recorded.</td></tr>'}</tbody></table>
<h2>Screen activity captures</h2>${captureRows || '<p>No screen captures were retained.</p>'}
</body></html>`;
    const data = Buffer.from(html, 'utf8');
    if (data.length > MAX_LOG_BYTES)
      throw new Error(
        'The automatic activity log exceeds 62 MiB. Remove some captures before submitting.',
      );
    return { filename: 'post-assessment-activity-log.html', data };
  }

  async completeAndDelete(): Promise<void> {
    this.stopTimer();
    const directory = this.sessionDirectory;
    this.manifest = null;
    this.sessionDirectory = null;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

function activeMacApplication(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      { timeout: 2000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}

async function capturePrimaryDisplay(): Promise<CaptureResult> {
  const primary = screen.getPrimaryDisplay();
  const pixelSize = boundedCaptureSize(primary);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: pixelSize,
    fetchWindowIcons: false,
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(primary.id)) ??
    sources[0];
  if (!source || source.thumbnail.isEmpty())
    throw new Error(
      'Screen recording permission is unavailable. Enable it in System Settings, then start recording again.',
    );
  return {
    jpeg: encodeCaptureJpeg(source.thumbnail),
    sourceName: source.name || 'Primary display',
  };
}

export function createPostAssessmentActivityRecorder(): PostAssessmentActivityRecorder {
  return new PostAssessmentActivityRecorder({
    recordsRoot: () =>
      path.join(app.getPath('userData'), 'post-assessment-recordings'),
    captureScreen: capturePrimaryDisplay,
    activeApplication: activeMacApplication,
    readConversations,
    readActivity,
  });
}
