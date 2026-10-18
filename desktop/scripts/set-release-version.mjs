import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function setReleaseVersion(appDirectory, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.[0-9]{14})?$/.test(version ?? '')) {
    throw new Error('Enter a stable version such as 0.1.1 or a nightly version such as 0.1.1-nightly.20261016060000 (without v).');
  }
  const packagePath = path.join(appDirectory, 'package.json');
  const lockPath = path.join(appDirectory, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!lock.packages?.['']) throw new Error('Missing lockfile root package.');
  manifest.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setReleaseVersion(path.resolve('desktop/release/app'), process.argv[2]);
}
