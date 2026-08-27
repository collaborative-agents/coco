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

  it('clears an observation bubble when the system suspends', () => {
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

  it('clears an unrevealed proactive bubble when Coco chat opens', () => {
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
    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The user may have made an error.',
        status: 'mistake',
        ts: Date.now() / 1000,
      });
    });
    expect(screen.getByText('Heads up')).toBeInTheDocument();

    act(() => {
      listeners.get('suppress-unrevealed-proactive-suggestion')?.();
    });
    expect(screen.queryByText('Heads up')).not.toBeInTheDocument();
  });

  it('does not engage or open chat when the instant tutor abstains', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sendMessage = jest.fn();
    const invoke = jest.fn((channel: string) => {
      if (channel === 'get-coco-sleep-mode') {
        return Promise.resolve({ sleeping: false });
      }
      if (channel === 'get-instant-suggestion') {
        return Promise.resolve({ status: 'abstained' });
      }
      return Promise.resolve([]);
    });
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage,
        invoke,
      },
    };

    render(<App />);
    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The user may need help with a completed draft.',
        observation_id: 'obs-abstain',
        status: 'support_needed',
        ts: Date.now() / 1000,
      });
    });

    fireEvent.click(screen.getByText('Help me with this'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('get-instant-suggestion', {
        observationId: 'obs-abstain',
      });
    });

    expect(sendMessage).not.toHaveBeenCalledWith(
      'help-me-with-this',
      expect.anything(),
    );
    expect(sendMessage.mock.calls).not.toContainEqual([
      'training-feedback',
      expect.objectContaining({ kind: 'engage' }),
    ]);
  });

  it('keeps Coco asleep on fox click and wakes it from the menu', async () => {
    const invoke = jest.fn(
      (channel: string, payload?: { sleeping?: boolean }) => {
        if (channel === 'get-coco-sleep-mode')
          return Promise.resolve({ sleeping: false });
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
    fireEvent.mouseEnter(screen.getByTitle('Open the chat'));
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
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Activity')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Settings'));
    expect(sendMessage).toHaveBeenCalledWith('open-chat-settings');
  });

  it('closes the contextual action menu when the avatar window loses focus', () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn().mockResolvedValue({ sleeping: false }),
      },
    };

    render(<App />);
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menu', { name: 'Coco actions' })).toBeInTheDocument();

    fireEvent.blur(window);
    expect(screen.queryByRole('menu', { name: 'Coco actions' })).not.toBeInTheDocument();
  });

  it('shows and approves the previous daily memory update', async () => {
    const sendMessage = jest.fn();
    const invoke = jest.fn((channel: string) => {
      if (channel === 'get-daily-memory-draft') {
        return Promise.resolve({
          draft: {
            draftId: 'draft-1',
            createdAt: 1,
            periodEnd: 1,
            summary: 'Daily update',
            bullets: [
              {
                id: 'preference-1',
                section: 'when_to_support',
                content:
                  'Offer help when repeated report formatting is visible.',
                confidence: 0.9,
                examples: [
                  'The user repeatedly reformatted the same report table.',
                ],
              },
            ],
          },
        });
      }
      if (channel === 'approve-daily-memory-draft') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ sleeping: false });
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage,
        invoke,
      },
    };

    render(<App />);
    expect(
      await screen.findByText(
        'Offer help when repeated report formatting is visible.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'daily-memory-review-visibility',
        { visible: true },
      );
    });
    expect(screen.getByText('When to proactively support')).toBeInTheDocument();
    fireEvent.click(screen.getByText('1 example'));
    expect(
      screen.getByText(
        'The user repeatedly reformatted the same report table.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve update'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('approve-daily-memory-draft', {
        draftId: 'draft-1',
      });
      expect(screen.getByText('Updated ✓')).toBeInTheDocument();
    });
  });
});
