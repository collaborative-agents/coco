const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yaml');
const afterPack = require('../.erb/scripts/after-pack.cjs');

test('writes the Mac update feed before a directory build is signed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-update-feed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await afterPack({
    electronPlatformName: 'darwin',
    appOutDir: directory,
    packager: {
      config: { publish: { provider: 'github', owner: 'collaborative-agents', repo: 'coco', token: 'must-not-ship' } },
      appInfo: { updaterCacheDirName: 'coco-updater' },
      getResourcesDir: () => directory,
    },
  });
  assert.deepEqual(YAML.parse(fs.readFileSync(path.join(directory, 'app-update.yml'), 'utf8')), {
    provider: 'github', owner: 'collaborative-agents', repo: 'coco', updaterCacheDirName: 'coco-updater',
  });
});

test('leaves Windows update configuration to electron-builder', async () => {
  await afterPack({ electronPlatformName: 'win32' });
});
