import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import YAML from 'yaml';
import { prepareReleaseArtifacts } from './prepare-release-artifacts.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'downloads');
  const destination = path.join(root, 'release');
  fs.mkdirSync(source);
  const add = (arch, version = '0.2.0') => {
    const directory = path.join(source, arch);
    fs.mkdirSync(directory);
    const filename = `coco-${version}-${arch}.${arch === 'windows' ? 'exe' : 'zip'}`;
    const bytes = Buffer.from(`installer ${arch}`);
    fs.writeFileSync(path.join(directory, filename), bytes);
    fs.writeFileSync(path.join(directory, `${filename}.blockmap`), 'blockmap');
    const manifest = {
      version,
      files: [{ url: filename, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }],
    };
    const metadata = path.join(directory, arch === 'windows' ? 'latest.yml' : 'latest-mac.yml');
    fs.writeFileSync(metadata, YAML.stringify(manifest));
    return { directory, filename, metadata, manifest };
  };
  return { source, destination, add };
}

test('combines both Mac architectures without overwriting update metadata', async (t) => {
  const { source, destination, add } = fixture(t);
  const arm = add('arm64');
  const intel = add('x64');
  const windows = add('windows');
  await prepareReleaseArtifacts(source, destination, '0.2.0');
  const mac = YAML.parse(fs.readFileSync(path.join(destination, 'latest-mac.yml'), 'utf8'));
  assert.deepEqual(mac.files.map((file) => file.url).sort(), [arm.filename, intel.filename].sort());
  assert.equal(mac.path, mac.files[0].url);
  assert.equal(mac.sha512, mac.files[0].sha512);
  assert.ok(fs.existsSync(path.join(destination, `${windows.filename}.blockmap`)));
  assert.equal(YAML.parse(fs.readFileSync(path.join(destination, 'latest.yml'), 'utf8')).version, '0.2.0');
});

test('supports a Windows-only release', async (t) => {
  const { source, destination, add } = fixture(t);
  add('windows');
  await prepareReleaseArtifacts(source, destination, '0.2.0');
  assert.ok(fs.existsSync(path.join(destination, 'latest.yml')));
  assert.ok(!fs.existsSync(path.join(destination, 'latest-mac.yml')));
});

for (const fault of ['wrong version', 'missing installer', 'checksum mismatch', 'duplicate filename']) {
  test(`rejects ${fault} before publication`, async (t) => {
    const { source, destination, add } = fixture(t);
    const item = add('arm64', fault === 'wrong version' ? '0.1.0' : '0.2.0');
    if (fault === 'missing installer') fs.unlinkSync(path.join(item.directory, item.filename));
    if (fault === 'checksum mismatch') fs.appendFileSync(path.join(item.directory, item.filename), 'changed');
    if (fault === 'duplicate filename') {
      const second = path.join(source, 'another-job');
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(second, item.filename), 'different installer');
    }
    await assert.rejects(prepareReleaseArtifacts(source, destination, '0.2.0'));
  });
}
