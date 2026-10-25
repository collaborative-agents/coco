import fs from 'fs';
import { readModelConfiguration } from './model-config-store';

jest.mock('electron', () => ({ app: { getPath: () => '/mock-coco' } }));
const config = {
  version: 1,
  sensing: {
    id: 'sensing',
    label: 'Sensing',
    provider: 'gemini',
    model: 'gemini/vision',
  },
  tutors: [
    {
      id: 'original',
      label: 'Original',
      provider: 'gemini',
      model: 'gemini/fast',
    },
  ],
  defaultTutorId: 'original',
};

afterEach(() => jest.restoreAllMocks());
it('migrates the Pi chat override while retaining sensing and the old suggestion model', () => {
  jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file) =>
      JSON.stringify(
        String(file).endsWith('pi-connection.json')
          ? { mode: 'native', provider: 'test', model: 'vendor/model' }
          : config,
      ),
    );
  const migrated = readModelConfiguration()!;
  expect(migrated.sensing).toEqual(config.sensing);
  expect(migrated.instantSuggestionModelId).toBe('original');
  expect(
    migrated.tutors.find((item) => item.id === migrated.defaultTutorId)?.model,
  ).toBe('pi/test/vendor/model');
});
it('ignores legacy overrides after unified configuration is saved', () => {
  const read = jest
    .spyOn(fs, 'readFileSync')
    .mockReturnValue(JSON.stringify({ ...config, unifiedRouting: true }));
  expect(readModelConfiguration()).toEqual(config);
  expect(read).toHaveBeenCalledTimes(1);
});

it('reloads an explicitly disabled sensing selection', () => {
  jest
    .spyOn(fs, 'readFileSync')
    .mockReturnValue(
      JSON.stringify({ ...config, sensing: null, unifiedRouting: true }),
    );
  expect(readModelConfiguration()).toEqual({ ...config, sensing: null });
});
