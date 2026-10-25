import configureFullscreenCompanionWindow from './fullscreen-companion-window';

describe('configureFullscreenCompanionWindow', () => {
  it('shows a floating companion surface in macOS fullscreen Spaces', () => {
    const window = {
      setAlwaysOnTop: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
    };

    configureFullscreenCompanionWindow(window as never, 'darwin');

    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
  });

  it('keeps always-on-top behavior without applying macOS Space settings', () => {
    const window = {
      setAlwaysOnTop: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
    };

    configureFullscreenCompanionWindow(window as never, 'win32');

    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });
});
