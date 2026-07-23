import fs from 'fs';
import path from 'path';
import { rimrafSync } from 'rimraf';

const projectRoot = path.join(__dirname, '../../');
const serviceDistRoot = path.join(projectRoot, 'service-dist');

interface ServiceCopyTask {
  name: string;
  source: string;
  dest: string;
  transform?: (content: string) => string;
}

interface DevServiceConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  type?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  restartOnCrash?: boolean;
  logPath?: string;
  env?: Record<string, string>;
  maxRestartsInWindow?: number;
  restartWindowMs?: number;
  initialRestartDelayMs?: number;
  shell:boolean
}

interface DevConfig {
  services: DevServiceConfig[];
}

interface ProdServiceConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  type?: string;
  command: string;
  args: string[];
  cwd: string;
  restartOnCrash: boolean;
  logPath: string;
  env?: Record<string, string>;
  maxRestartsInWindow?: number;
  restartWindowMs?: number;
  initialRestartDelayMs?: number;
  shell:boolean
}

interface ProdConfig {
  services: ProdServiceConfig[];
}


/**
 * Transform a development service config to production config
 *
 * Transformation rules:
 * 1. Python services (type: "python" or command: "uv"/"python"):
 *    - Development: Use uv/python to run source code modules
 *    - Production: Use PyInstaller bundled executable (filename = service.id)
 *
 * 2. Node services (type: "node" or command: "npm"/"node"):
 *    - Development: Use npm/node to run source code
 *    - Production: Use ncc bundled JS file (path in gemini-agent directory)
 *
 * 3. Other services:
 *    - If command is already an absolute path or contains ${SERVICE_DIST_ROOT}, keep as is
 *    - Otherwise keep original (may require manual configuration)
 */
function transformServiceToProduction(service: DevServiceConfig): ProdServiceConfig {
  const base: ProdServiceConfig = {
    id: service.id,
    name: service.name,
    restartOnCrash: service.restartOnCrash ?? true,
    command: '',
    args: [],
    cwd: '',
    logPath: '',
    shell:true
  };

  // Determine service type: prioritize type field, otherwise infer from command
  const isPythonService =
    service.type === 'python' ||
    service.command === 'uv' ||
    service.command === 'python' ||
    (service.command && service.command.includes('python'));

  const isNodeService =
    service.type === 'node' ||
    service.command === 'npm' ||
    service.command === 'node' ||
    (service.command && service.command.includes('npm'));

  // Apply transformation rules based on service type
  if (isPythonService) {
    // Python service: use PyInstaller-bundled executable.
    // The binary name matches the service id (e.g. "sensing-server").
    // On Windows, PyInstaller produces .exe; on macOS/Linux, no extension.
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    base.command = '${SERVICE_DIST_ROOT}/' + service.id + '/' + service.id + exeSuffix;
    // Strip the "uv run python -m <module>" prefix from args, keep only CLI flags.
    const rawArgs = service.args || [];
    const cliArgs: string[] = [];
    let skipNext = false;
    for (const arg of rawArgs) {
      if (skipNext) { skipNext = false; continue; }
      if (arg === 'run' || arg === 'python') continue;
      if (arg === '-m') { skipNext = true; continue; }
      if (arg.startsWith('-m')) continue; // handles "-mmodule" form
      // Anything that looks like a dotted module name (no dash prefix) right after -m removal
      if (!arg.startsWith('-') && arg.includes('.') && cliArgs.length === 0) continue;
      cliArgs.push(arg);
    }
    base.args = cliArgs;
    base.cwd = '${SERVICE_DIST_ROOT}/' + service.id;
    base.logPath = '${ELECTRON_UI_ROOT}/logs/' + service.id + '.log';
    base.shell = service.shell ?? true;
  } else if (isNodeService) {
    // Node service: Use bundled JavaScript file
    // Assume all Node services are bundled in corresponding directories (e.g., gemini-agent/index.js)
    // If cwd contains service directory name, use that directory; otherwise use service.id as directory name
    const serviceDir = service.id;
    base.type = 'node';
    base.command = '${SERVICE_DIST_ROOT}/' + serviceDir + '/index.js';
    base.args = [];
    base.cwd = '${SERVICE_DIST_ROOT}/' + serviceDir;
    base.logPath = '${SERVICE_DIST_ROOT}/logs/' + service.id + '.log';
    base.shell = service.shell ?? true;
  } else {
    // Other services: Check if already in production config format
    const command = service.command || '';
    if (command.includes('${SERVICE_DIST_ROOT}') || path.isAbsolute(command)) {
      // Already in production config format, use directly
      base.command = command;
      base.args = service.args || [];
      base.cwd = service.cwd || '';
      base.logPath = service.logPath || '';
    } else {
      // Unknown type, keep as is (may require manual configuration)
      base.command = command;
      base.args = service.args || [];
      base.cwd = service.cwd || '';
      base.logPath = service.logPath || '';
    }
  }

  // Copy optional properties
  if (service.enabled !== undefined) base.enabled = service.enabled;
  if (service.env) base.env = service.env;
  if (service.maxRestartsInWindow !== undefined) {
    base.maxRestartsInWindow = service.maxRestartsInWindow;
  }
  if (service.restartWindowMs !== undefined) {
    base.restartWindowMs = service.restartWindowMs;
  }
  if (service.initialRestartDelayMs !== undefined) {
    base.initialRestartDelayMs = service.initialRestartDelayMs;
  }

  return base;
}

/**
 * Transform development config JSON to production config JSON
 */
function transformConfigToProduction(devConfigContent: string): string {
  const devConfig: DevConfig = JSON.parse(devConfigContent);

  const prodConfig: ProdConfig = {
    services: devConfig.services.map(transformServiceToProduction),
  };

  return JSON.stringify(prodConfig, null, 2) + '\n';
}


/**
 * Recursively copy a file or directory
 */
function copyRecursiveSync(src: string, dest: string): void {
  const exists = fs.existsSync(src);
  if (!exists) {
    throw new Error(`Source does not exist: ${src}`);
  }

  const stats = fs.statSync(src);
  const isDirectory = stats.isDirectory();

  if (isDirectory) {
    // Copy directory
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else {
    // Copy file
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
}

/**
 * Copy a file with optional transformation
 */
function copyWithTransform(
  source: string,
  dest: string,
  transform?: (content: string) => string
): void {
  if (transform) {
    // Transform and write
    const content = fs.readFileSync(source, 'utf8');
    const transformed = transform(content);
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(dest, transformed, 'utf8');
  } else {
    // Direct copy
    copyRecursiveSync(source, dest);
  }
}


interface ServiceCopyTaskDef extends ServiceCopyTask {
  optional?: boolean;
}

const serviceTasks: ServiceCopyTaskDef[] = [
  {
    name: 'services-config',
    source: path.join(projectRoot, 'src/main/services/config.json'),
    dest: path.join(serviceDistRoot, 'services.json'),
    transform: transformConfigToProduction,
  },
];

if (!fs.existsSync(serviceDistRoot)) {
  fs.mkdirSync(serviceDistRoot, { recursive: true });
}

console.log('📦 Starting to copy services...\n');

serviceTasks.forEach((task) => {
  console.log(`Processing ${task.name}...`);

  if (fs.existsSync(task.dest)) {
    console.log(`  🧹 Cleaning ${task.dest}`);
    rimrafSync(task.dest);
  }

  if (!fs.existsSync(task.source)) {
    if (task.optional) {
      console.warn(`  ⚠️  Source not found (optional), skipping: ${task.source}`);
      return;
    }
    console.error(`  ❌ Source not found: ${task.source}`);
    process.exit(1);
  }

  try {
    console.log(`  📋 Copying from ${task.source} to ${task.dest}`);
    copyWithTransform(task.source, task.dest, task.transform);
    const action = task.transform ? 'transformed and copied' : 'copied';
    console.log(`  ✅ ${task.name} ${action} successfully.\n`);
  } catch (error) {
    console.error(`  ❌ Failed to copy ${task.name}:`, error);
    process.exit(1);
  }
});

console.log('✨ All services copied successfully.');
