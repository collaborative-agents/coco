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

  it('keeps Coco asleep on fox click and wakes it from the menu', async () => {
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
        sendMessage: jest.fn(),
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

    fireEvent.click(screen.getByTitle('Open the chat'));
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

  it('opens History and Settings from the contextual action menu', async () => {
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
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Activity')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Settings'));
    expect(sendMessage).toHaveBeenCalledWith('open-chat-settings');
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
