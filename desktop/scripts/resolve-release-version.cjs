const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
};

module.exports = function resolveReleaseVersion(input, tags) {
  const versions = tags.filter(tag => /^v/.test(tag)).map(tag => tag.slice(1)).filter(tag => stable.test(tag)).sort(compare);
  const current = versions.at(-1) || null;
  const suggested = current
    ? `${current.split('.').slice(0, 2).join('.')}.${BigInt(current.split('.')[2]) + 1n}`
    : '0.1.0';
  const version = !input?.trim() || input.trim() === 'auto' ? suggested : input.trim();
  if (!stable.test(version)) throw new Error('Use auto or a stable version such as 0.1.3 (without v).');
  if (current && compare(version, current) <= 0) throw new Error(`Version must be higher than the latest stable tag v${current}. Suggested: ${suggested}`);
  return { current, suggested, version };
};
