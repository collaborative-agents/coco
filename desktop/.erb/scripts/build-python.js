const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '../../../');
const buildSensingServerScript = path.join(projectRoot, 'build_sensing_server.py');
const buildTutorServerScript = path.join(projectRoot, 'build_tutor_server.py');

console.log(`🐍 Building Python services...`);

function buildPythonService(scriptPath, serviceName) {
  console.log(`\n📦 Building ${serviceName}...`);
  console.log(`   Script: ${scriptPath}`);

  if (!fs.existsSync(scriptPath)) {
    console.warn(`⚠️  Build script not found, skipping ${serviceName} (services will run from source via uv)`);
    return;
  }

  console.log(`   Using uv run to execute with correct Python version`);
  const result = spawnSync('uv', ['run', scriptPath], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    console.error(`❌ ${serviceName} build failed to start:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`❌ ${serviceName} build exited with code ${result.status}`);
    process.exit(result.status || 1);
  }

  console.log(`✅ ${serviceName} built successfully.`);
}

buildPythonService(buildSensingServerScript, 'Sensing Server');
buildPythonService(buildTutorServerScript, 'Tutor Server');

console.log('\n✨ Python services build step completed.');
