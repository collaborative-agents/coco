const { test } = require('node:test');
const assert = require('node:assert/strict');
const resolve = require('./resolve-release-version.cjs');
test('auto follows current tags each run', () => {
  assert.equal(resolve('auto', ['v0.1.1','v0.1.2']).version, '0.1.3');
  assert.equal(resolve('auto', ['v0.1.3','v0.1.2']).version, '0.1.4');
});
test('compares semver numerically and ignores unrelated/prerelease tags', () => {
  assert.equal(resolve('', ['v0.1.9','v0.1.10','v1.0.0-beta','other']).version, '0.1.11');
});
test('supports explicit newer versions and rejects old/invalid ones', () => {
  assert.equal(resolve('0.2.0', ['v0.1.2']).version, '0.2.0');
  for (const input of ['0.1.2','0.1.1','v0.1.3','bad']) assert.throws(() => resolve(input,['v0.1.2']));
});
test('bootstraps a repository without release tags', () => {
  assert.equal(resolve('auto', []).version, '0.1.0');
});
