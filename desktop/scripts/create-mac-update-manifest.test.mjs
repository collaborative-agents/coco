import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import createMacUpdateManifest from './create-mac-update-manifest.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coco-update-manifest-'));
  const armDir = join(root, 'arm64');
  const x64Dir = join(root, 'x64');
  mkdirSync(armDir);
  mkdirSync(x64Dir);
  const armZip = join(armDir, 'coco-0.1.1-arm64-mac.zip');
  const x64Zip = join(x64Dir, 'coco-0.1.1-mac.zip');
  writeFileSync(armZip, 'arm64-update');
  writeFileSync(`${armZip}.blockmap`, 'arm64-blockmap');
  writeFileSync(x64Zip, 'x64-update');
  writeFileSync(`${x64Zip}.blockmap`, 'x64-blockmap');
  return { root, armZip, x64Zip };
}

test('creates one manifest for arm64 and x64 differential updates', () => {
  const { root } = fixture();
  const outputPath = join(root, 'latest-mac.yml');

  createMacUpdateManifest({ artifactsDir: root, outputPath, version: '0.1.1' });

  const manifest = readFileSync(outputPath, 'utf8');
  assert.match(manifest, /version: "0\.1\.1"/);
  assert.match(manifest, /coco-0\.1\.1-arm64-mac\.zip/);
  assert.match(manifest, /coco-0\.1\.1-mac\.zip/);
  assert.equal((manifest.match(/sha512:/g) ?? []).length, 3);
});

test('creates a manifest when only the arm64 update is packaged', () => {
  const { root, x64Zip } = fixture();
  unlinkSync(x64Zip);
  unlinkSync(`${x64Zip}.blockmap`);
  const outputPath = join(root, 'latest-mac.yml');

  createMacUpdateManifest({ artifactsDir: root, outputPath, version: '0.1.1' });

  const manifest = readFileSync(outputPath, 'utf8');
  assert.match(manifest, /coco-0\.1\.1-arm64-mac\.zip/);
  assert.doesNotMatch(manifest, /coco-0\.1\.1-mac\.zip/);
  assert.equal((manifest.match(/sha512:/g) ?? []).length, 2);
});

test('creates a manifest when only the x64 update is packaged', () => {
  const { root, armZip } = fixture();
  unlinkSync(armZip);
  unlinkSync(`${armZip}.blockmap`);
  const outputPath = join(root, 'latest-mac.yml');

  createMacUpdateManifest({ artifactsDir: root, outputPath, version: '0.1.1' });

  const manifest = readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(manifest, /coco-0\.1\.1-arm64-mac\.zip/);
  assert.match(manifest, /coco-0\.1\.1-mac\.zip/);
  assert.equal((manifest.match(/sha512:/g) ?? []).length, 2);
});

test('rejects a release when a differential blockmap is missing', () => {
  const { root, x64Zip } = fixture();
  unlinkSync(`${x64Zip}.blockmap`);

  assert.throws(
    () =>
      createMacUpdateManifest({
        artifactsDir: root,
        outputPath: join(root, 'latest-mac.yml'),
        version: '0.1.1',
      }),
    /Missing differential blockmap/,
  );
});

test('requires a stable semantic version', () => {
  const { root } = fixture();
  assert.throws(
    () =>
      createMacUpdateManifest({
        artifactsDir: root,
        outputPath: join(root, 'latest-mac.yml'),
        version: 'build-12',
      }),
    /stable semver/,
  );
});
