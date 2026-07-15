import { notarize } from '@electron/notarize';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json using ESM
const packageJsonPath = join(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const { build } = packageJson;

export default async function notarizeMacos(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  if (process.env.CI !== 'true') {
    console.warn('Skipping notarizing step. Packaging is not running in CI');
    return;
  }

  if (
    !(
      'APPLE_ID' in process.env &&
      'APPLE_ID_PASS' in process.env &&
      'APPLE_TEAM_ID' in process.env
    )
  ) {
    console.warn(
      'Skipping notarizing step. APPLE_ID, APPLE_ID_PASS, and APPLE_TEAM_ID env variables must be set',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  await notarize({
    tool: 'notarytool',
    appBundleId: build.appId,
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASS,
    teamId: process.env.APPLE_TEAM_ID,
  });
}
