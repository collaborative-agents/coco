import configureMainWindow from './main-window-behavior';

describe('Main window stacking', () => {
  it.each(['darwin', 'win32', 'linux'])(
    'stays below other focused apps on %s, including when reopened',
    (platform) => {
      const window = {
        setAlwaysOnTop: jest.fn(),
        setVisibleOnAllWorkspaces: jest.fn(),
      };
      configureMainWindow(window, platform);
      configureMainWindow(window, platform);
      expect(window.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
      if (platform === 'darwin') {
        expect(window.setVisibleOnAllWorkspaces.mock.calls).toEqual([
          [false],
          [false],
        ]);
      } else {
        expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
      }
    },
  );
});
