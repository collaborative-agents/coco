const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { serializeToYaml } = require('builder-util');
const {
  getAppUpdatePublishConfiguration,
} = require('app-builder-lib/out/publish/PublishManager');

// electron-builder 25 only embeds update configuration for dmg/zip targets.
// Our signed --dir checkpoint needs the same file BEFORE its signature is made.
module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const config = await getAppUpdatePublishConfiguration(
    context.packager,
    context.arch,
    false,
  );
  if (!config) throw new Error('Missing macOS update publish configuration');
  await writeFile(
    path.join(
      context.packager.getResourcesDir(context.appOutDir),
      'app-update.yml',
    ),
    serializeToYaml(config),
  );
};
