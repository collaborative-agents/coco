import type { BrowserWindow } from 'electron';
import { Menu } from 'electron';
import enableSelectionCopy from './selection-copy';

jest.mock('electron', () => ({
  Menu: { buildFromTemplate: jest.fn(() => ({ popup: jest.fn() })) },
}));

function setup() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const copy = jest.fn();
  const window = {
    webContents: {
      copy,
      on: (name: string, callback: (...args: any[]) => void) =>
        listeners.set(name, callback),
    },
  };
  enableSelectionCopy(window as unknown as BrowserWindow);
  return { listeners, copy, window };
}

it('copies the focused web contents selection for the platform copy shortcut', () => {
  const { listeners, copy } = setup();
  const preventDefault = jest.fn();
  listeners.get('before-input-event')?.(
    { preventDefault },
    {
      type: 'keyDown',
      key: 'c',
      meta: process.platform === 'darwin',
      control: process.platform !== 'darwin',
    },
  );
  expect(copy).toHaveBeenCalledTimes(1);
  expect(preventDefault).toHaveBeenCalledTimes(1);
});

it('leaves typing, keyup, and unrelated shortcuts alone', () => {
  const { listeners, copy } = setup();
  const preventDefault = jest.fn();
  [
    { type: 'keyDown', key: 'c' },
    { type: 'keyUp', key: 'c', meta: true, control: true },
    { type: 'keyDown', key: 'c', meta: true, control: true, shift: true },
    { type: 'keyDown', key: 'c', meta: true, control: true, isComposing: true },
    { type: 'keyDown', key: 'v', meta: true, control: true },
  ].forEach((input) => {
    listeners.get('before-input-event')?.({ preventDefault }, input);
  });
  expect(copy).not.toHaveBeenCalled();
  expect(preventDefault).not.toHaveBeenCalled();
});

it('offers right-click Copy only for a selection and copies that selection', () => {
  jest.mocked(Menu.buildFromTemplate).mockClear();
  const { listeners, copy, window } = setup();
  listeners.get('context-menu')?.({}, { selectionText: '' });
  expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  listeners.get('context-menu')?.({}, { selectionText: 'only this part' });
  const item = jest.mocked(Menu.buildFromTemplate).mock.calls[0][0][0];
  (item.click as () => void)();
  expect(copy).toHaveBeenCalledTimes(1);
  expect(
    jest.mocked(Menu.buildFromTemplate).mock.results[0].value.popup,
  ).toHaveBeenCalledWith({ window });
});
