const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '../../../../');
const buildSensingServerScript = path.join(projectRoot, 'build_sensing_server.py');
const buildBrowserUseAgentScript = path.join(projectRoot, 'build_browser_use_agent.py');

console.log(`🐍 Building Python services...`);

// Build function for a Python service
function buildPythonService(scriptPath, serviceName) {
  console.log(`\n📦 Building ${serviceName}...`);
  console.log(`   Script: ${scriptPath}`);

  // Check if script exists
  if (!fs.existsSync(scriptPath)) {
    console.error(`❌ Python build script not found at: ${scriptPath}`);
    process.exit(1);
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

// Build all Python services
buildPythonService(buildSensingServerScript, 'Sensing Server');
buildPythonService(buildBrowserUseAgentScript, 'Browser Use Agent');

console.log('\n✨ All Python services built successfully.');
