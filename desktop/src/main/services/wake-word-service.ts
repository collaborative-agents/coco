import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export type WakeWordStatus =
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'sleeping'
  | 'error';

export interface WakeWordStatusEvent {
  status: WakeWordStatus;
  detail?: string;
}

interface WakeWordServiceOptions {
  projectRoot: string;
  modelDir: string;
  stateDir: string;
  logPath: string;
  packagedExecutable?: string;
  onStatus: (event: WakeWordStatusEvent) => void;
  onDetected: (keyword: string) => void;
}

/** Owns the low-resource sherpa-onnx subprocess; audio is never queued. */
export class WakeWordService {
  private readonly options: WakeWordServiceOptions;

  private child: ChildProcessWithoutNullStreams | null = null;

  private stdoutBuffer = '';

  private acceptingAudio = true;

  constructor(options: WakeWordServiceOptions) {
    this.options = options;
  }

  start(): void {
    if (this.child) return;
    fs.mkdirSync(path.dirname(this.options.logPath), { recursive: true });
    fs.mkdirSync(this.options.stateDir, { recursive: true });
    const workerArgs = [
      '--model-dir',
      this.options.modelDir,
      '--state-dir',
      this.options.stateDir,
    ];
    const command = this.options.packagedExecutable ?? 'uv';
    const args = this.options.packagedExecutable
      ? workerArgs
      : [
          'run',
          '--package',
          'sensing',
          'python',
          '-m',
          'sensing.wake_word_worker',
          ...workerArgs,
        ];

    this.options.onStatus({ status: 'starting' });
    const child = spawn(command, args, {
      cwd: this.options.projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.acceptingAudio = true;
    this.appendLog(`Starting ${command} ${args.join(' ')}\n`);
    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) =>
      this.appendLog(chunk.toString()),
    );
    child.on('error', (error) => {
      this.appendLog(`${error.stack ?? error.message}\n`);
      this.options.onStatus({ status: 'error', detail: error.message });
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const detail = `Wake-word worker exited (${signal ?? code ?? 'unknown'}).`;
      this.appendLog(`${detail}\n`);
      this.options.onStatus({ status: 'error', detail });
    });
  }

  writeAudio(frame: Buffer): boolean {
    if (
      !this.child?.stdin.writable ||
      !this.acceptingAudio ||
      frame.length === 0
    ) {
      return false;
    }
    const accepted = this.child.stdin.write(frame);
    if (!accepted) {
      this.acceptingAudio = false;
      this.child.stdin.once('drain', () => {
        this.acceptingAudio = true;
      });
    }
    return accepted;
  }

  stop(status: WakeWordStatus = 'disabled'): void {
    const { child } = this;
    this.child = null;
    this.stdoutBuffer = '';
    this.acceptingAudio = true;
    if (child) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    this.options.onStatus({ status });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    lines.forEach((line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as {
          type?: string;
          keyword?: string;
          detail?: string;
        };
        if (message.type === 'ready') {
          this.options.onStatus({ status: 'ready' });
        } else if (message.type === 'detected' && message.keyword) {
          this.options.onDetected(message.keyword);
        } else if (message.type === 'error') {
          this.options.onStatus({
            status: 'error',
            detail: message.detail ?? 'Wake-word worker failed.',
          });
        }
      } catch {
        this.appendLog(`[stdout] ${line}\n`);
      }
    });
  }

  private appendLog(text: string): void {
    fs.appendFileSync(
      this.options.logPath,
      `${new Date().toISOString()} ${text}`,
      'utf8',
    );
  }
}
