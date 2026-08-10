const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '../../../');
const packagingScriptsDir = path.join(projectRoot, 'scripts', 'packaging');
const servicesSpec = path.join(packagingScriptsDir, 'coco_services.spec');
const serviceDistRoot = path.join(projectRoot, 'desktop', 'service-dist');
const workPath = path.join(projectRoot, 'build', 'pyinstaller-services');

console.log(`🐍 Building Python services...`);

if (!fs.existsSync(servicesSpec)) {
  console.error(`❌ Shared services spec not found: ${servicesSpec}`);
  process.exit(1);
}

// Remove outputs from the old two-bundle layout so extraResources cannot ship
// both the legacy runtimes and the new shared runtime.
['sensing-server', 'tutor-server', 'coco-services'].forEach((directory) => {
  fs.rmSync(path.join(serviceDistRoot, directory), {
    recursive: true,
    force: true,
  });
});

console.log(`\n📦 Building shared sensing and tutor runtime...`);
console.log(`   Spec: ${servicesSpec}`);
const result = spawnSync(
  'uv',
  [
    'run',
    'python',
    '-m',
    'PyInstaller',
    servicesSpec,
    `--distpath=${serviceDistRoot}`,
    `--workpath=${workPath}`,
    '--noconfirm',
    '--clean',
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  },
);

if (result.error) {
  console.error(
    '❌ Shared Python services build failed to start:',
    result.error,
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `❌ Shared Python services build exited with code ${result.status}`,
  );
  process.exit(result.status || 1);
}

console.log('\n✨ Python services build step completed.');
