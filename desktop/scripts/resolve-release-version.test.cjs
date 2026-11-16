const { test } = require('node:test');
const assert = require('node:assert/strict');
const resolve = require('./resolve-release-version.cjs');

test('auto starts at the app version when only older tags exist', () => {
  assert.equal(resolve('auto', ['v0.1.1', 'v0.1.12'], '0.2.0').version, '0.2.0');
});
test('auto follows current tags each run', () => {
  assert.equal(resolve('auto', ['v0.2.0', 'v0.2.1'], '0.2.0').version, '0.2.2');
  assert.equal(resolve('auto', ['v0.2.3', 'v0.2.2'], '0.2.0').version, '0.2.4');
});
test('compares semver numerically and ignores unrelated/prerelease tags', () => {
  assert.equal(resolve('', ['v0.2.9', 'v0.2.10', 'v1.0.0-beta', 'other'], '0.2.0').version, '0.2.11');
});
test('supports explicit newer versions and rejects old/invalid ones', () => {
  assert.equal(resolve('0.3.0', ['v0.2.2'], '0.2.0').version, '0.3.0');
  for (const input of ['0.2.2', '0.2.1', 'v0.2.3', 'bad'])
    assert.throws(() => resolve(input, ['v0.2.2'], '0.2.0'));
  assert.throws(() => resolve('0.1.9', [], '0.2.0'), /at least/);
});
test('bootstraps a repository without release tags', () => {
  assert.equal(resolve('auto', [], '0.2.0').version, '0.2.0');
});
test('uses the app manifest as its default release floor', () => {
  const version = require('../release/app/package.json').version;
  assert.equal(resolve('auto', []).version, version);
});
test('advances to a newly committed minor version', () => {
  assert.equal(resolve('auto', ['v0.2.9'], '0.3.0').version, '0.3.0');
});
