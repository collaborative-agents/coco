import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Retry transport failures, not compiler errors, bad credentials, or rejections.
export const isTransient = (output) =>
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|network connection was lost|network.*(?:unavailable|error)|could not resolve host|failed to (?:connect|download)|connection (?:reset|timed out)|timed out|timeout|CloudKit's response is inconsistent|(?:HTTP|status(?: code)?)[^\n]*\b(?:429|50[0234])\b/i.test(
    output,
  );

export async function retry(
  operation,
  { attempts = 4, sleep = setTimeout } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error.message)) throw error;
      const delay = Math.min(15 * 2 ** (attempt - 1), 60);
      console.warn(
        `Transport failure; retry ${attempt + 1}/${attempts} in ${delay}s`,
      );
      await sleep(delay * 1000);
    }
  }
}

export function execute(command, args) {
  return new Promise((resolve, reject) => {
    // npm/npx are cmd scripts on Windows. Workflow calls use bash for those.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Stream CI logs while retaining a bounded tail for error classification.
    const limit = 32 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      stdout = (stdout + chunk).slice(-limit);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-limit);
    });
    child.on('error', (error) => {
      console.error(error.message);
      reject(error);
    });
    child.on('close', (status) => {
      if (status === 0) return resolve(stdout);
      const error = new Error(`${stdout}\n${stderr}`);
      error.status = status || 1;
      reject(error);
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: retry-command.mjs command [args...]');
  try {
    await retry(() => execute(command, args));
  } catch (error) {
    console.error(
      'Command failed; retries exhausted or failure is not transient.',
    );
    process.exitCode = error.status || 1;
  }
}
