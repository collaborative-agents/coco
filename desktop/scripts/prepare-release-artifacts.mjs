import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

async function checksum(file) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

function* filesIn(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesIn(file);
    else if (entry.isFile()) yield file;
  }
}

// Separate architecture jobs each produce latest-mac.yml. Merge their file
// lists so one architecture cannot overwrite the other's update download.
export async function prepareReleaseArtifacts(source, destination, version) {
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Artifact destination must be empty.');
  const manifests = new Map();
  let installers = 0;
  for (const file of filesIn(source)) {
    const name = path.basename(file);
    if (/^latest(?:-mac)?\.yml$/.test(name)) {
      const manifest = YAML.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.version !== version || !manifest.files?.length)
        throw new Error(`Invalid update metadata in ${file}: expected version ${version}.`);
      const merged = manifests.get(name) || { ...manifest, files: [] };
      for (const item of manifest.files) {
        const previous = merged.files.find((candidate) => candidate.url === item.url);
        if (previous && previous.sha512 !== item.sha512)
          throw new Error(`Conflicting update checksum for ${item.url}.`);
        if (!previous) merged.files.push(item);
      }
      manifests.set(name, merged);
      continue;
    }
    if (!/\.(?:dmg|zip|exe|blockmap)$/.test(name)) continue;
    const target = path.join(destination, name);
    if (fs.existsSync(target)) {
      if (await checksum(target) !== await checksum(file))
        throw new Error(`Conflicting release artifact: ${name}.`);
    } else fs.copyFileSync(file, target);
    if (/\.(?:dmg|zip|exe)$/.test(name)) installers += 1;
  }
  if (!installers || !manifests.size) throw new Error('Missing installers or update metadata.');
  for (const [name, manifest] of manifests) {
    for (const item of manifest.files) {
      const filename = decodeURIComponent(item.url);
      if (path.basename(filename) !== filename || /[\\/]/.test(filename))
        throw new Error(`Invalid update filename: ${item.url}.`);
      const file = path.join(destination, filename);
      if (!fs.existsSync(file)) throw new Error(`Missing update artifact: ${filename}.`);
      if (await checksum(file) !== item.sha512)
        throw new Error(`Update checksum mismatch: ${filename}.`);
      if (item.size !== undefined && fs.statSync(file).size !== item.size)
        throw new Error(`Update size mismatch: ${filename}.`);
    }
    // Keep the legacy fields consistent with the merged files list.
    manifest.path = manifest.files[0].url;
    manifest.sha512 = manifest.files[0].sha512;
    fs.writeFileSync(path.join(destination, name), YAML.stringify(manifest));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination, version] = process.argv.slice(2);
  if (!source || !destination || !version)
    throw new Error('Usage: prepare-release-artifacts.mjs source destination version');
  await prepareReleaseArtifacts(source, destination, version);
}
