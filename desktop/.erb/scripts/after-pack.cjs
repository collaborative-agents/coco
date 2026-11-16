const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');

// CI signs a --dir build and creates installers from it after notarization.
// electron-builder skips app-update.yml for --dir, so write it before signing.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { publish } = context.packager.config;
  if (publish?.provider !== 'github') return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  await fs.writeFile(path.join(resources, 'app-update.yml'), YAML.stringify({
    provider: 'github',
    owner: publish.owner,
    repo: publish.repo,
    updaterCacheDirName: context.packager.appInfo.updaterCacheDirName,
  }));
};
