import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function collectFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

function yamlString(value) {
  return JSON.stringify(value);
}

export default function createMacUpdateManifest({
  artifactsDir,
  outputPath,
  version,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Release version must be stable semver (for example 0.1.1): ${version}`,
    );
  }

  const zipPaths = collectFiles(artifactsDir).filter((path) =>
    /-mac\.zip$/.test(basename(path)),
  );
  if (zipPaths.length !== 2) {
    throw new Error(
      `Expected exactly two macOS update ZIPs (arm64 and x64), found ${zipPaths.length}.`,
    );
  }

  const names = new Set(zipPaths.map((path) => basename(path)));
  if (names.size !== zipPaths.length) {
    throw new Error(
      'macOS update ZIP names must be unique across architectures.',
    );
  }

  const files = zipPaths
    .map((path) => {
      const name = basename(path);
      if (!name.includes(`-${version}-`)) {
        throw new Error(
          `Update ZIP does not contain release version ${version}: ${name}`,
        );
      }
      if (!existsSync(`${path}.blockmap`)) {
        throw new Error(`Missing differential blockmap: ${name}.blockmap`);
      }
      return {
        name,
        path,
        arm64: name.includes('arm64'),
        sha512: sha512(path),
        size: statSync(path).size,
      };
    })
    .sort((left, right) => Number(left.arm64) - Number(right.arm64));

  if (files.filter((file) => file.arm64).length !== 1) {
    throw new Error('Expected one arm64 ZIP and one x64 ZIP.');
  }

  const legacyFile = files.find((file) => !file.arm64) ?? files[0];
  const releaseDate = new Date().toISOString();
  const lines = [
    `version: ${yamlString(version)}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${yamlString(file.name)}`,
      `    sha512: ${yamlString(file.sha512)}`,
      `    size: ${file.size}`,
    ]),
    `path: ${yamlString(legacyFile.name)}`,
    `sha512: ${yamlString(legacyFile.sha512)}`,
    `releaseDate: ${yamlString(releaseDate)}`,
    '',
  ];

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, lines.join('\n'));
  return { files, outputPath };
}

function parseArguments(argv) {
  if (argv.length % 2 !== 0) {
    throw new Error(`Invalid arguments: ${argv.join(' ')}`);
  }
  const pairs = Array.from({ length: argv.length / 2 }, (_, index) => [
    argv[index * 2],
    argv[index * 2 + 1],
  ]);
  if (pairs.some(([key, value]) => !key?.startsWith('--') || !value)) {
    throw new Error(`Invalid arguments: ${argv.join(' ')}`);
  }
  const values = Object.fromEntries(
    pairs.map(([key, value]) => [key.slice(2), value]),
  );
  const missing = ['artifacts', 'output', 'version'].find(
    (required) => !values[required],
  );
  if (missing) throw new Error(`Missing --${missing}`);
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = createMacUpdateManifest({
      artifactsDir: resolve(args.artifacts),
      outputPath: resolve(args.output),
      version: args.version,
    });
    process.stdout.write(
      `Created ${result.outputPath} for ${result.files.map((file) => file.name).join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
