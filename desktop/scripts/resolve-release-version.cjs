const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
};

module.exports = function resolveReleaseVersion(input, tags, baseVersion = require('../release/app/package.json').version) {
  if (!stable.test(baseVersion)) throw new Error('The app manifest must contain a stable release version.');
  const versions = tags.filter(tag => /^v/.test(tag)).map(tag => tag.slice(1)).filter(tag => stable.test(tag)).sort(compare);
  const current = versions.at(-1) || null;
  const next = current
    ? `${current.split('.').slice(0, 2).join('.')}.${BigInt(current.split('.')[2]) + 1n}`
    : baseVersion;
  const suggested = compare(next, baseVersion) >= 0 ? next : baseVersion;
  const version = !input?.trim() || input.trim() === 'auto' ? suggested : input.trim();
  if (!stable.test(version)) throw new Error('Use auto or a stable version such as 0.2.0 (without v).');
  if (compare(version, baseVersion) < 0) throw new Error(`Version must be at least the app manifest version ${baseVersion}.`);
  if (current && compare(version, current) <= 0) throw new Error(`Version must be higher than the latest stable tag v${current}. Suggested: ${suggested}`);
  return { current, suggested, version };
};
