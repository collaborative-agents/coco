import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from '../renderer/App';

describe('App', () => {
  it('hides the avatar from the three-dot menu without sleeping or quitting', async () => {
    const invoke = jest.fn().mockResolvedValue({ success: true });
    const sendMessage = jest.fn();
    (window as any).electron = { ipcRenderer: { on: jest.fn(() => jest.fn()), invoke, sendMessage } };
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update-avatar-visibility', { hideAvatar: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(invoke.mock.calls.some(([channel]) => channel === 'set-coco-sleep-mode')).toBe(false);
  });

  it('keeps the menu open when hiding fails', async () => {
    const invoke = jest.fn(async (channel) => channel === 'update-avatar-visibility' ? { success: false } : []);
    (window as any).electron = { ipcRenderer: { on: jest.fn(() => jest.fn()), invoke, sendMessage: jest.fn() } };
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not hide Coco');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('should render', () => {
    expect(render(<App />)).toBeTruthy();
  });

  it('clears an observation bubble when the system suspends', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage: jest.fn(),
        invoke: jest.fn().mockResolvedValue([]),
      },
    };

    render(<App />);
    await waitFor(() => {
      expect(window.electron?.ipcRenderer.invoke).toHaveBeenCalledWith(
        'get-coco-sleep-mode',
      );
    });
    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The user may have made an error.',
        status: 'mistake',
        ts: Date.now() / 1000,
      });
    });
    expect(screen.getByText('Heads up')).toBeInTheDocument();

    act(() => listeners.get('system-suspend')?.());
    expect(screen.queryByText('Heads up')).not.toBeInTheDocument();
  });

  it('keeps Coco asleep on avatar click and wakes it from the menu', async () => {
    const sendMessage = jest.fn();
    const invoke = jest.fn(
      (channel: string, payload?: { sleeping?: boolean }) => {
        if (channel === 'get-coco-sleep-mode') {
          return Promise.resolve({ sleeping: false });
        }
        return Promise.resolve({ success: true, sleeping: payload?.sleeping });
      },
    );
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage,
        invoke,
      },
    };

    render(<App />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('get-coco-sleep-mode');
    });
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Sleep'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set-coco-sleep-mode', {
        sleeping: true,
      });
    });

    fireEvent.click(screen.getByAltText('Desktop Pet'));
    expect(sendMessage).not.toHaveBeenCalledWith('open-main-window');
    expect(invoke).not.toHaveBeenCalledWith('set-coco-sleep-mode', {
      sleeping: false,
    });

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Wake Coco'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set-coco-sleep-mode', {
        sleeping: false,
      });
    });
  });

  it('opens the action menu when the avatar is right-clicked', () => {
    const sendMessage = jest.fn();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(
          (channel: string, callback: (...args: unknown[]) => void) => {
            listeners.set(channel, callback);
            return () => listeners.delete(channel);
          },
        ),
        sendMessage,
        invoke: jest.fn().mockResolvedValue({ sleeping: false }),
      },
    };

    render(<App />);
    expect(screen.getByText('Right-click for menu')).toBeInTheDocument();
    const avatarContainer = screen
      .getByAltText('Desktop Pet')
      .closest('.pet-container');
    expect(avatarContainer).not.toBeNull();

    fireEvent.contextMenu(avatarContainer!);
    expect(
      screen.getByRole('menu', { name: 'Coco actions' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Open Chat')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('More actions'));
    act(() => listeners.get('open-avatar-actions-menu')?.());
    expect(
      screen.getByRole('menu', { name: 'Coco actions' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Open Chat'));
    expect(sendMessage).toHaveBeenCalledWith('open-main-window');
  });

  it('offers consistent navigation and Quit, without History', async () => {
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage,
        invoke: jest.fn((channel: string) =>
          Promise.resolve(
            channel === 'get-coco-sleep-mode' ? { sleeping: false } : [],
          ),
        ),
      },
    };

    render(<App />);
    await waitFor(() => {
      expect(window.electron?.ipcRenderer.invoke).toHaveBeenCalledWith(
        'get-coco-sleep-mode',
      );
    });
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open Chat', 'Settings', 'Hide', 'Sleep', 'Quit',
    ]);
    expect(screen.queryByRole('menuitem', { name: /History/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Personalization' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Settings'));
    expect(sendMessage).toHaveBeenCalledWith('open-chat-settings');

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quit' }));
    expect(sendMessage).toHaveBeenCalledWith('quit-from-avatar');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the contextual action menu when the avatar window loses focus', async () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn().mockResolvedValue({ sleeping: false }),
      },
    };

    render(<App />);
    await waitFor(() => {
      expect(window.electron?.ipcRenderer.invoke).toHaveBeenCalledWith(
        'get-coco-sleep-mode',
      );
    });
    fireEvent.click(screen.getByTitle('More actions'));
    expect(
      screen.getByRole('menu', { name: 'Coco actions' }),
    ).toBeInTheDocument();

    fireEvent.blur(window);
    expect(
      screen.queryByRole('menu', { name: 'Coco actions' }),
    ).not.toBeInTheDocument();
  });
});
