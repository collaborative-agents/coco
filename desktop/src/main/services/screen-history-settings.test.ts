import fs from 'fs';
import os from 'os';
import path from 'path';
import ScreenHistorySettings from './screen-history-settings';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-history-settings-'));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('defaults to on and honors an explicit environment override until saved', async () => {
  const file = path.join(directory, 'settings.json');
  const defaults = new ScreenHistorySettings(
    () => file,
    () => undefined,
  );
  expect(defaults.read()).toBe(true);
  const disabled = new ScreenHistorySettings(
    () => file,
    () => '0',
  );
  expect(disabled.read()).toBe(false);
  await disabled.set(true, async () => {});
  expect(
    new ScreenHistorySettings(
      () => file,
      () => '0',
    ).read(),
  ).toBe(true);
});

it('remembers an off choice across launches and applies it before saving', async () => {
  const file = path.join(directory, 'settings.json');
  const settings = new ScreenHistorySettings(() => file);
  const apply = jest.fn(async (enabled) => {
    expect(enabled).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
  await settings.set(false, apply);
  expect(
    new ScreenHistorySettings(
      () => file,
      () => '1',
    ).read(),
  ).toBe(false);
  expect(apply).toHaveBeenCalledTimes(1);
});

it('does not claim an off setting was saved when collection could not be stopped', async () => {
  const file = path.join(directory, 'settings.json');
  const settings = new ScreenHistorySettings(
    () => file,
    () => undefined,
  );
  await expect(
    settings.set(false, async () => {
      throw new Error('Unavailable');
    }),
  ).rejects.toThrow('Unavailable');
  expect(settings.read()).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
});

it('serializes changes from multiple windows so the saved state matches collection', async () => {
  const settings = new ScreenHistorySettings(() =>
    path.join(directory, 'settings.json'),
  );
  const applied: boolean[] = [];
  let finish: () => void = () => {};
  const first = settings.set(false, async (value) => {
    applied.push(value);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const second = settings.set(true, async (value) => {
    applied.push(value);
  });
  await Promise.resolve();
  expect(applied).toEqual([false]);
  finish();
  await Promise.all([first, second]);
  expect(applied).toEqual([false, true]);
  expect(settings.read()).toBe(true);
});

it('keeps collection off if saved settings are corrupt and allows a new choice', async () => {
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, 'invalid JSON');
  const settings = new ScreenHistorySettings(
    () => file,
    () => '1',
  );
  expect(settings.read()).toBe(false);
  await settings.set(true, async () => {});
  expect(settings.read()).toBe(true);
});
