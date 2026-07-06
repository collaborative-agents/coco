import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import log from 'electron-log';

export interface ServiceConfig {
  id: string;
  name?: string;
  enabled?: boolean; // when false, skip launching (default true). Overridable via SERVICES_ENABLED / SERVICES_DISABLED env vars.
  type?: 'process' | 'node'; // Added type
  command?: string;
  args?: string[];
  cwd?: string;
  restartOnCrash?: boolean;
  maxRestartsInWindow?: number; // maximum restarts allowed within restartWindowMs
  restartWindowMs?: number; // window to count restarts (ms)
  initialRestartDelayMs?: number; // base delay for restart (ms)
  logPath?: string;
  platforms?: string[];
  env?: Record<string, string>;
  shell?: boolean | string;
}

// Parse SERVICES_ENABLED / SERVICES_DISABLED env vars (comma-separated ids).
// SERVICES_ENABLED, if set, is an allowlist (only these run, regardless of config.enabled).
// SERVICES_DISABLED is a denylist applied on top of config.enabled.
function parseServiceFilter(value: string | undefined): Set<string> | null {
  if (!value) return null;
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function isServiceEnabled(cfg: ServiceConfig): boolean {
  const allowlist = parseServiceFilter(process.env.SERVICES_ENABLED);
  const denylist = parseServiceFilter(process.env.SERVICES_DISABLED);
  if (allowlist) return allowlist.has(cfg.id);
  if (denylist?.has(cfg.id)) return false;
  return cfg.enabled !== false;
}

export interface ServiceProcess {
  process: ChildProcess | null;
  config?: ServiceConfig;
  status: 'stopped' | 'running' | 'error';
  crashTimestamps?: number[]; // recent crash timestamps for backoff logic
  restartTimer?: ReturnType<typeof setTimeout> | null; // scheduled restart timer
  logStream?: fs.WriteStream | null;
}

export class ServiceManager {
  // registry holds processes and lightweight metadata
  private services: Map<string, ServiceProcess> = new Map();

  // placeholders for later steps
  // PROJECT_ROOT should point to the repo root, not the desktop app directory.
  // In dev the cwd is the desktop app dir (.../coco/desktop); go up one level
  // to reach the repo root where the Python services run (cwd=${PROJECT_ROOT}).
  private projectRoot: string = (() => {
    const cwd = process.cwd();
    const parts = cwd.split(path.sep);
    const desktopIndex = parts.lastIndexOf('desktop');
    if (desktopIndex > 0) {
      return parts.slice(0, desktopIndex).join(path.sep);
    }
    // Fallback: assume cwd is already the repo root or use it as is.
    return cwd;
  })();

  // The directory where services will actually run (User Data/services in Prod)
  private runtimeServicesRoot: string = '';

  private configPath: string | null = null;

  constructor() {
    this.setupExitHandler();
    this.initializePaths();
  }

  private initializePaths() {
    if (app.isPackaged) {
      this.runtimeServicesRoot = path.join(
        process.resourcesPath,
        'service-dist',
      );
    } else {
      // In development, we run directly from the source/dist
      this.runtimeServicesRoot = path.resolve(this.projectRoot, 'service-dist');
    }
    log.info(
      `[ServiceManager] Services root initialized: ${this.runtimeServicesRoot}`,
    );
  }

  /** register a spawned child process into the global registry */
  public registerProcess(id: string, proc: ChildProcess, cfg?: ServiceConfig) {
    this.services.set(id, { process: proc, config: cfg, status: 'running' });

    proc.on('error', (err) => {
      log.error(`[ServiceManager] child ${id} error`, err);
      const s = this.services.get(id);
      if (s) s.status = 'error';
    });

    proc.on('exit', (code, signal) => {
      log.info(
        `[ServiceManager] child ${id} exited code=${code} signal=${signal}`,
      );
      const s = this.services.get(id);
      if (s) {
        s.process = null;
        s.status = 'stopped';
      }
    });

    ServiceManager.attachPipesToChild(id, proc);
  }

  /** load services configuration from a JSON file (default dev path) */
  public loadConfig(configPath?: string) {
    const envPath = process.env.SERVICE_CONFIG_PATH;

    let candidate = configPath || envPath;

    if (!candidate) {
      if (!app.isPackaged) {
        // In Development: Prefer source config to run services from source (npm start, uv run)
        // instead of running the packaged binaries in service-dist
        const srcConfig = path.resolve(
          this.projectRoot,
          'desktop',
          'src/main/services/config.json',
        );
        if (fs.existsSync(srcConfig)) {
          candidate = srcConfig;
        } else {
          // Fallback to service-dist if source config is missing
          candidate = path.join(this.runtimeServicesRoot, 'services.json');
          log.info(
            `[ServiceManager] Source config not found, trying fallback: ${candidate}`,
          );
        }
      } else {
        // In Production: Always use the services.json from the runtime directory
        candidate = path.join(this.runtimeServicesRoot, 'services.json');
        log.info(`[ServiceManager] Production mode, using: ${candidate}`);
      }
    }

    try {
      if (!fs.existsSync(candidate)) {
        log.warn(`[ServiceManager] config not found at ${candidate}`);
        return;
      }
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      const services = parsed.services as ServiceConfig[];
      if (!Array.isArray(services)) return;

      // In the packaged app process.cwd() is not the monorepo, so the class
      // property initialiser for projectRoot is wrong.  dotenv has already run
      // by the time loadConfig() is called, so honour PROJECT_ROOT from .env
      // if set (the bundled .env should contain PROJECT_ROOT=<monorepo path>).
      const projectRoot = process.env.PROJECT_ROOT || this.projectRoot;
      const electronUiRoot = process.env.ELECTRON_UI_ROOT ||
        path.resolve(projectRoot, 'desktop');

      const userDataRoot = app.getPath('userData');

      const expand = (v?: string) =>
        typeof v === 'string'
          ? v
              .replace(/\$\{PROJECT_ROOT\}/g, projectRoot)
              .replace(/\$\{ELECTRON_UI_ROOT\}/g, electronUiRoot)
              .replace(/\$\{ASSETS_ROOT\}/g, this.runtimeServicesRoot)
              .replace(/\$\{SERVICE_DIST_ROOT\}/g, this.runtimeServicesRoot)
              .replace(/\$\{USER_DATA_ROOT\}/g, userDataRoot)
              // Fallback: any remaining ${VAR} is resolved from process.env
              // (populated by dotenv from the monorepo / electron-ui .env files
              // in main.ts). Lets config.json reference values like
              // ${GATEWAY_URL} instead of hardcoding deployment URLs.
              // Unset vars expand to '' which is then dropped at the env-merge
              // step, falling through to whatever the parent process inherits.
              .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
                const val = process.env[name];
                if (val == null) {
                  log.warn(
                    `[ServiceManager] ${name} referenced in config but not set in env`,
                  );
                  return '';
                }
                return val;
              })
          : v;

      services.forEach((svc) => {
        // populate registry entries (stopped)
        this.services.set(svc.id, {
          process: null,
          config: {
            ...svc,
            command: expand(svc.command),
            cwd: svc.cwd ? path.normalize(expand(svc.cwd)!) : undefined,
            logPath: svc.logPath
              ? path.normalize(expand(svc.logPath)!)
              : undefined,
            args: Array.isArray(svc.args)
              ? svc.args.map((a) => expand(a)!)
              : svc.args,
            env: svc.env
              ? (Object.fromEntries(
                  Object.entries(svc.env).map(([k, v]) => [
                    k,
                    typeof v === 'string' ? expand(v) : (v ?? ''),
                  ]),
                ) as Record<string, string>)
              : undefined,
          },
          status: 'stopped',
          crashTimestamps: [],
          restartTimer: null,
        });
      });

      this.configPath = candidate;
      log.info(`[ServiceManager] loaded services config from ${candidate}`);
    } catch (e) {
      log.warn('[ServiceManager] failed to load service config', e);
    }
  }

  /** start all services declared in config */
  public async startAll() {
    if (this.services.size === 0) this.loadConfig();
    this.services.forEach((_, id) => {
      try {
        this.startService(id);
      } catch (e) {
        log.warn(`[ServiceManager] failed to start service ${id}`, e);
      }
    });
  }

  /** start a single service by id (uses registered config) */
  public startService(id: string) {
    const svc = this.services.get(id);
    if (!svc || !svc.config) {
      log.warn(`[ServiceManager] no config for service ${id}`);
      return;
    }

    const cfg = svc.config;

    // enabled gating (config.enabled + SERVICES_ENABLED / SERVICES_DISABLED env)
    if (!isServiceEnabled(cfg)) {
      log.info(
        `[ServiceManager] skipping ${id}: disabled by config.enabled or SERVICES_ENABLED/SERVICES_DISABLED env`,
      );
      svc.status = 'stopped';
      return;
    }

    // platform gating
    if (
      Array.isArray(cfg.platforms) &&
      cfg.platforms.length > 0 &&
      !cfg.platforms.includes(process.platform)
    ) {
      log.info(
        `[ServiceManager] skipping ${id}: platform ${process.platform} not in ${cfg.platforms}`,
      );
      svc.status = 'stopped';
      return;
    }

    if (svc.process) {
      log.info(`[ServiceManager] ${id} already running`);
      return;
    }

    // choose command and args: if cfg.command includes spaces and no args, run via shell
    let command = cfg.command || '';
    let { args } = cfg;

    // Handle Node.js services using Electron's internal Node.
    // Drop empty-string entries from cfg.env so placeholders like
    // `"GEMINI_API_KEY": ""` in config.json don't shadow values inherited
    // from process.env (loaded via dotenv in main.ts).
    const cfgEnvNonEmpty = cfg.env
      ? Object.fromEntries(
          Object.entries(cfg.env).filter(([, v]) => v !== ''),
        )
      : {};
    // When Electron is launched as a packaged GUI app (e.g. from Finder or the
    // Dock) macOS only provides a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
    // Tools like `uv` installed by Homebrew or the official installer live in
    // directories that are NOT on that path.  Augment it here so child processes
    // can find uv, python, node, etc. regardless of how the app was opened.
    const extraPaths = [
      '/usr/local/bin',          // Homebrew (Intel) + uv official installer
      '/opt/homebrew/bin',       // Homebrew (Apple Silicon)
      `${os.homedir()}/.local/bin`,  // uv official installer (user-level)
      `${os.homedir()}/.cargo/bin`,  // Rust/cargo tools
    ].join(path.delimiter);
    const augmentedPath = `${extraPaths}${path.delimiter}${process.env.PATH || ''}`;

    let env = {
      ...process.env,
      ...cfgEnvNonEmpty,
      PYTHONIOENCODING: 'utf-8',
      PATH: augmentedPath,
    };

    // Special handling for npm start commands: convert to direct node execution
    // This avoids Electron sandbox issues with shell execution
    let convertedToNode = false;
    if (command === 'npm' && args?.[0] === 'start' && cfg.cwd) {
      const distPath = path.join(cfg.cwd, 'dist', 'index.js');
      log.info(
        `[ServiceManager] Checking npm start conversion for ${id}, distPath: ${distPath}`,
      );

      // Check if dist/index.js exists
      if (fs.existsSync(distPath)) {
        log.info(
          `[ServiceManager] Converting npm start to direct node execution for ${id}`,
        );
        // Find node executable path
        let nodePath: string | null = null;

        // Try to find node in PATH
        const pathDirs = (process.env.PATH || '').split(path.delimiter);
        log.info(
          `[ServiceManager] Searching for node in PATH (${pathDirs.length} directories)`,
        );
        for (const dir of pathDirs) {
          if (!dir) continue;
          try {
            const possibleNodePath = path.join(dir, 'node');
            if (fs.existsSync(possibleNodePath)) {
              nodePath = possibleNodePath;
              log.info(`[ServiceManager] Found node in PATH: ${nodePath}`);
              break;
            }
          } catch (e) {
            // Ignore
          }
        }

        // If node not found in PATH, try to use execSync to find it
        if (!nodePath) {
          try {
            log.info(
              `[ServiceManager] Node not found in PATH, trying which node`,
            );
            const whichNode = execSync('which node', {
              encoding: 'utf8',
              timeout: 2000,
              env: { ...process.env, PATH: process.env.PATH },
            }).trim();
            if (whichNode && fs.existsSync(whichNode)) {
              nodePath = whichNode;
              log.info(`[ServiceManager] Found node via which: ${nodePath}`);
            }
          } catch (e) {
            log.warn(`[ServiceManager] Failed to find node via which: ${e}`);
          }
        }

        if (nodePath) {
          // Use node to execute dist/index.js directly
          command = nodePath;
          args = ['dist/index.js'];
          convertedToNode = true;
          log.info(
            `[ServiceManager] ✅ Converted to: ${command} ${args.join(' ')} for ${id}`,
          );
        } else {
          log.error(
            `[ServiceManager] ❌ Node not found, falling back to npm start (will likely fail due to sandbox)`,
          );
          // Fallback to original npm start (will likely fail due to sandbox)
        }
      } else {
        log.warn(
          `[ServiceManager] dist/index.js not found at ${distPath}, falling back to npm start`,
        );
        // dist/index.js doesn't exist, need to run npm start to compile first
        // This will likely fail due to sandbox, but we try anyway
      }
    } else if (cfg.type === 'node' && app.isPackaged) {
      // Use Electron executable as the node interpreter ONLY in production
      const scriptPath = command;
      command = process.execPath;
      args = [scriptPath, ...(args || [])];

      const isWin = process.platform === 'win32';
      env = {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: process.env.PATH,
        // Only fix LOCALAPPDATA on Windows to prevent cache write errors
        ...(isWin
          ? {
              LOCALAPPDATA:
                process.env.LOCALAPPDATA ||
                path.join(os.homedir(), 'AppData', 'Local'),
            }
          : {}),
      };
      log.info(
        `[ServiceManager] launching node service ${id} using ${command} ${scriptPath}`,
      );
    }

    // If we converted npm start to node dist/index.js, don't use shell
    // Only use shell if we're still using npm (fallback case)
    // convertedToNode flag ensures we don't use shell after conversion
    const npmStartCommandShell =
      command === 'npm' && args?.[0] === 'start' ? cfg?.shell : false;
    const useShell = convertedToNode ? false : npmStartCommandShell;

    log.info(
      `[ServiceManager] Final command for ${id}: ${command} ${args?.join(' ') || ''}, shell: ${useShell}`,
    );

    const child = this.spawnAndRegister(id, command, args, {
      cwd: cfg.cwd,
      logPath: cfg.logPath,
      env: env as NodeJS.ProcessEnv,
      shell: useShell,
    });

    // augment crash tracking
    svc.crashTimestamps = svc.crashTimestamps || [];
    svc.status = 'running';

    // attach a specialized exit handler to trigger restart/backoff
    child.on('exit', (code) => {
      const now = Date.now();
      if (cfg.restartOnCrash && code !== 0 && code !== null) {
        // prune timestamps older than window
        const windowMs = cfg.restartWindowMs || 60_000;
        svc.crashTimestamps = (svc.crashTimestamps || []).filter(
          (t) => now - t < windowMs,
        );
        svc.crashTimestamps.push(now);
        const maxRestarts = cfg.maxRestartsInWindow || 3;
        if ((svc.crashTimestamps || []).length >= maxRestarts) {
          svc.status = 'error';
          log.warn(
            `[ServiceManager] ${id} exceeded max restarts (${maxRestarts}) within ${windowMs}ms, not restarting`,
          );
          return;
        }

        // compute backoff delay
        const base = cfg.initialRestartDelayMs || 1000;
        const attempt = (svc.crashTimestamps || []).length;
        const delay = Math.min(base * 2 ** (attempt - 1), 60_000);
        log.info(`[ServiceManager] scheduling restart of ${id} in ${delay}ms`);
        svc.restartTimer = setTimeout(() => {
          svc.restartTimer = null;
          this.startService(id);
        }, delay);
      } else {
        svc.status = 'stopped';
      }
    });
  }

  /** attach stdout/stderr to electron-log and optional file */
  private static attachPipesToChild(
    id: string,
    child: ChildProcess,
    logStream?: fs.WriteStream | null,
  ) {
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const msg = String(chunk).trim();
        if (msg) log.info(`[${id}] ${msg}`);
        if (logStream && msg) logStream.write(`[stdout] ${msg}\n`);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const msg = String(chunk).trim();
        // Temporary filter for known Python shutdown noise
        if (
          msg.includes(
            'RuntimeError: cannot schedule new futures after shutdown',
          )
        )
          return;

        if (msg) log.warn(`[${id}] ${msg}`);
        if (logStream && msg) logStream.write(`[stderr] ${msg}\n`);
      });
    }
  }

  /** spawn a process, attach pipes, and register it */
  public spawnAndRegister(
    id: string,
    command: string,
    args?: string[],
    opts?: {
      cwd?: string;
      logPath?: string;
      shell?: boolean | string;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    const cwd = opts?.cwd || this.projectRoot;
    let logStream: fs.WriteStream | null = null;
    if (opts?.logPath) {
      try {
        const absLogPath = path.isAbsolute(opts.logPath)
          ? opts.logPath
          : path.resolve(this.projectRoot, opts.logPath);

        log.info(`[ServiceManager] 📝 Log path for ${id}: ${absLogPath}`);

        const dir = path.dirname(absLogPath);
        if (!fs.existsSync(dir)) {
          log.info(`[ServiceManager] 📁 Creating log directory: ${dir}`);
          fs.mkdirSync(dir, { recursive: true });
        }

        if (fs.existsSync(absLogPath)) {
          try {
            const stats = fs.statSync(absLogPath);
            if (stats.size > 5 * 1024 * 1024) {
              const oldPath = `${absLogPath}.old`;
              if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
              fs.renameSync(absLogPath, oldPath);
              log.info(`[ServiceManager] 🔄 Rotated log ${absLogPath} to .old`);
            }
          } catch (e) {
            log.warn(
              `[ServiceManager] ⚠️ Failed to rotate log ${absLogPath}`,
              e,
            );
          }
        }

        logStream = fs.createWriteStream(absLogPath, { flags: 'a' });
        log.info(
          `[ServiceManager] ✅ Log stream created for ${id}: ${absLogPath}`,
        );

        const timestamp = new Date().toISOString();
        logStream.write(`\n${'='.repeat(60)}\n`);
        logStream.write(`[${timestamp}] Service ${id} starting...\n`);
        logStream.write(
          `[${timestamp}] Command: ${command} ${(args || []).join(' ')}\n`,
        );
        logStream.write(`[${timestamp}] Working directory: ${cwd}\n`);
        logStream.write(`${'='.repeat(60)}\n\n`);
      } catch (e) {
        log.error(
          `[ServiceManager] ❌ Failed to create log stream for ${id}:`,
          e,
        );
      }
    } else {
      log.warn(`[ServiceManager] ⚠️ No logPath configured for ${id}`);
    }
    const spawnOpts: any = {
      cwd,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        ...(opts?.env || {}), // Merge custom environment variables
      },
    };
    if (process.platform === 'win32' && command === 'npm') {
      spawnOpts.shell = true;

      const systemRoot = process.env.SystemRoot || 'C:\\Windows';

      spawnOpts.env = {
        ...process.env,
        ...spawnOpts.env,
        SystemRoot: systemRoot,
        ComSpec:
          process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
      };

      const pathKey = Object.keys(spawnOpts.env).find(
        (k) => k.toLowerCase() === 'path',
      );

      if (pathKey) {
        const npmPaths = [
          path.join(systemRoot, 'System32'),
          process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
          process.env.ProgramFiles
            ? path.join(process.env.ProgramFiles, 'nodejs')
            : null,
        ].filter(Boolean);

        spawnOpts.env[pathKey] = [...npmPaths, spawnOpts.env[pathKey]].join(
          path.delimiter,
        );
      } else {
        spawnOpts.env.PATH = [
          path.join(systemRoot, 'System32'),
          process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
          process.env.ProgramFiles
            ? path.join(process.env.ProgramFiles, 'nodejs')
            : null,
        ]
          .filter(Boolean)
          .join(path.delimiter);
      }
    } else if (typeof opts?.shell === 'string') {
      spawnOpts.shell = opts.shell;
    } else if (opts?.shell === true) {
      spawnOpts.shell = true;
    }
    const child = spawn(command, args || [], {
      ...spawnOpts,
    });

    child.on('error', (err) => {
      const errorMsg = `[${new Date().toISOString()}] ❌ Process ${id} failed to spawn: ${err.message}\n`;
      log.error(`[ServiceManager] ${errorMsg}`);

      // 写入日志文件
      if (logStream && !logStream.destroyed) {
        logStream.write(errorMsg);
      }

      // 写入 electron-log
      if (log) {
        log.error(`[ServiceManager] child ${id} error`, err);
      }
    });

    log.info(`[ServiceManager] ✅ Process spawned: PID=${child.pid}`);

    ServiceManager.attachPipesToChild(id, child, logStream);

    this.registerProcess(id, child, {
      id,
      name: id,
      command,
      args,
      cwd,
      logPath: opts?.logPath,
      env: opts?.env
        ? (Object.fromEntries(
            Object.entries(opts?.env).filter(([, v]) => v !== undefined),
          ) as Record<string, string>)
        : undefined,
    });
    const s = this.services.get(id);
    if (s) s.logStream = logStream;

    return child;
  }

  /**
   * Stop a service with a polite SIGTERM then wait up to `timeoutMs` for exit.
   * If the process doesn't exit in time and `force` is true, send SIGKILL.
   *
   * This sets the service status to 'stopped' but does NOT remove the registry
   * entry so the service can be restarted later.
   */
  public async stopService(
    id: string,
    opts?: { timeoutMs?: number; force?: boolean },
  ) {
    const s = this.services.get(id);
    if (!s) return;

    if (!s.process) {
      s.status = 'stopped';
      return;
    }

    // cancel pending restart if any
    if (s.restartTimer) {
      clearTimeout(s.restartTimer);
      s.restartTimer = null;
    }

    const proc = s.process;
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const force = opts?.force ?? true;

    const exitPromise = new Promise<boolean>((resolve) => {
      const cleanup = () => {
        proc.removeListener('exit', cleanup);
        proc.removeListener('error', cleanup);
        resolve(true);
      };
      proc.on('exit', cleanup);
      proc.on('error', cleanup);
    });

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    });

    try {
      // attempt graceful termination
      try {
        proc.kill('SIGTERM' as any);
      } catch (e) {
        log.warn(`[ServiceManager] failed to send SIGTERM to ${id}`, e);
      }

      const exited = await Promise.race([exitPromise, timeoutPromise]);

      if (!exited && force) {
        log.warn(
          `[ServiceManager] ${id} did not exit within ${timeoutMs}ms — sending SIGKILL`,
        );
        try {
          proc.kill('SIGKILL' as any);
        } catch (e) {
          log.warn(`[ServiceManager] failed to send SIGKILL to ${id}`, e);
        }
        // wait briefly for process to exit after SIGKILL
        await Promise.race([
          exitPromise,
          new Promise((resolve) => {
            setTimeout(resolve, 2000);
          }),
        ]);
      }
    } catch (e) {
      log.warn(`[ServiceManager] failed to stop ${id}`, e);
    } finally {
      s.process = null;
      s.status = 'stopped';
      if (s.logStream) {
        try {
          s.logStream.end();
        } catch {
          // ignore
        }
        s.logStream = null;
      }
    }
  }

  /**
   * Update environment variables for a service and restart it if running.
   * @param id - Service ID
   * @param envUpdates - Object with environment variable key-value pairs to update
   */
  public async updateServiceEnv(
    id: string,
    envUpdates: Record<string, string>,
  ) {
    const svc = this.services.get(id);
    if (!svc || !svc.config) {
      log.warn(`[ServiceManager] no config for service ${id}`);
      return;
    }

    // Update the service's environment configuration
    svc.config.env = {
      ...svc.config.env,
      ...envUpdates,
    };

    log.info(`[ServiceManager] updated env for ${id}:`, envUpdates);

    if (svc.process) {
      log.info(`[ServiceManager] restarting ${id} with updated environment`);
      await this.stopService(id);
      // Wait a bit for the process to fully stop
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.startService(id);
    } else {
      log.info(`[ServiceManager] starting ${id} with new environment`);
      this.startService(id);
    }
  }

  /** kill all registered children (used on exit) */
  public async killAll() {
    log.info('[ServiceManager] killing all child processes');
    const ids = Array.from(this.services.keys());
    await Promise.all(ids.map((id) => this.stopService(id)));
  }

  /**
   * Shutdown helper: attempt to stop all services and honor a timeout to
   * avoid blocking app quit indefinitely.
   *
   * @param timeoutMs maximum milliseconds to wait before giving up (default 10s)
   */
  public async shutdown(timeoutMs = 10_000) {
    try {
      // ask all services to stop (they have per-service timeouts)
      const stopPromise = this.killAll();

      await Promise.race([
        stopPromise,
        new Promise((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);

      // after waiting (or timeout), force-kill any remaining processes
      const remaining = Array.from(this.services.entries()).filter(
        ([, s]) => !!s.process,
      );

      if (remaining.length > 0) {
        log.warn(
          `[ServiceManager] shutdown timed out; force-killing ${remaining.length} remaining process(es)`,
        );
        remaining.forEach(([id, s]) => {
          try {
            s.process?.kill('SIGKILL' as any);
          } catch (e) {
            log.warn(`[ServiceManager] failed to SIGKILL ${id}`, e);
          }
        });
        // brief wait to let the OS clean up
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }

      log.info('[ServiceManager] shutdown complete');
    } catch (e) {
      log.warn('[ServiceManager] error during shutdown', e);
    }
  }

  private setupExitHandler() {
    const onExit = async () => {
      try {
        await this.killAll();
      } catch (e) {
        log.warn('[ServiceManager] error while killing children on exit', e);
      }
    };

    process.on('exit', onExit);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
  }
}

export const serviceManager = new ServiceManager();
