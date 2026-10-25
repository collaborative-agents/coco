import configureMainWindow, { resizeMainWindow } from './main-window-behavior';

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

describe('Main window width changes', () => {
  const makeWindow = (x = 120, width = 520) => ({
    getBounds: () => ({ x, y: 85, width, height: 650 }),
    setBounds: jest.fn(),
    isMaximized: () => false,
    isFullScreen: () => false,
  });
  it('preserves position and user-selected height when expanding', () => {
    const window = makeWindow();
    resizeMainWindow(window, 1160, { x: 0, width: 1920 });
    expect(window.setBounds).toHaveBeenCalledWith({
      x: 120,
      y: 85,
      width: 1160,
      height: 650,
    });
  });
  it('leaves an already expanded window untouched', () => {
    const window = makeWindow(120, 1160);
    resizeMainWindow(window, 1160, { x: 0, width: 1920 });
    expect(window.setBounds).not.toHaveBeenCalled();
  });
  it('keeps expansion inside a secondary display without changing vertical position', () => {
    const window = makeWindow(-700);
    resizeMainWindow(window, 1160, { x: -1920, width: 1920 });
    expect(window.setBounds).toHaveBeenCalledWith({
      x: -1160,
      y: 85,
      width: 1160,
      height: 650,
    });
  });
  it('preserves maximized and fullscreen windows', () => {
    for (const state of ['isMaximized', 'isFullScreen'] as const) {
      const window = { ...makeWindow(), [state]: () => true };
      resizeMainWindow(window, 1160, { x: 0, width: 1920 });
      expect(window.setBounds).not.toHaveBeenCalled();
    }
  });
});
