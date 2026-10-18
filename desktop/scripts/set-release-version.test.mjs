import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setReleaseVersion } from './set-release-version.mjs';

test('updates all version fields while preserving other configuration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-release-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = { name: 'coco-learn', version: '0.1.0', dependencies: {} };
  const lock = { version: '0.1.0', lockfileVersion: 3, packages: { '': manifest } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  setReleaseVersion(dir, '0.1.2');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))), { ...manifest, version: '0.1.2' });
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
  assert.equal(result.version, '0.1.2');
  assert.equal(result.packages[''].version, '0.1.2');
  assert.equal(result.lockfileVersion, 3);
});

test('accepts a timestamped nightly version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-nightly-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = { name: 'coco-learn', version: '0.1.0' };
  const lock = { version: '0.1.0', packages: { '': manifest } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  setReleaseVersion(dir, '0.1.1-nightly.20261016060000');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version, '0.1.1-nightly.20261016060000');
});

test('rejects invalid, prerelease and prefixed versions before writing', () => {
  for (const version of ['', undefined, 'v0.1.1', '01.1.1', '0.1.1-beta', '0.1.1-nightly.x', '0.1', '../file']) {
    assert.throws(() => setReleaseVersion('/not-used', version), /stable version/);
  }
});
