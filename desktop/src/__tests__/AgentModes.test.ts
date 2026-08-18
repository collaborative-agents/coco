import {
  DEFAULT_SUPPORTED_MODES,
  defaultMode,
  normalizeSupportedModes,
} from '../shared/agent-modes';

describe('packaged agent mode configuration', () => {
  it('accepts a worker-upskilling-only build', () => {
    const modes = normalizeSupportedModes(['ai_upskilling']);
    expect(modes).toEqual(['ai_upskilling']);
    expect(defaultMode(modes)).toBe('ai_upskilling');
  });

  it('drops unknown and duplicate mode ids while preserving order', () => {
    expect(
      normalizeSupportedModes([
        'ai_upskilling',
        'unknown',
        'ai_upskilling',
        'student_learning',
      ]),
    ).toEqual(['ai_upskilling', 'student_learning']);
  });

  it('falls back to all modes for missing or empty configuration', () => {
    expect(normalizeSupportedModes(undefined)).toEqual(DEFAULT_SUPPORTED_MODES);
    expect(normalizeSupportedModes([])).toEqual(DEFAULT_SUPPORTED_MODES);
  });
});
