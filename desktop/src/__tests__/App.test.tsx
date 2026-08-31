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

  it('shows a social avatar alert and opens the Friends inbox', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage,
        invoke: jest.fn().mockResolvedValue([]),
      },
    };

    render(<App />);
    act(() => {
      listeners.get('social-avatar-notification')?.({
        title: 'New message',
        message: 'participant-2 sent you a message.',
        participantId: 'participant-2',
      });
    });

    expect(screen.getByText('New message')).toBeInTheDocument();
    expect(
      screen.getByText('participant-2 sent you a message.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open Friends →'));

    expect(sendMessage).toHaveBeenCalledWith(
      'social-avatar-notification-closed',
    );
    expect(sendMessage).toHaveBeenCalledWith('open-social-inbox');
    expect(screen.queryByText('New message')).not.toBeInTheDocument();
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

  it('does not replace a pinned suggestion with incoming observations', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const invoke = jest.fn((channel: string) => {
      if (channel === 'get-coco-sleep-mode') {
        return Promise.resolve({ sleeping: false });
      }
      if (channel === 'get-instant-suggestion') {
        return Promise.resolve({
          status: 'ready',
          suggestion: {
            kind: 'content',
            title: 'Review the report structure',
            body: 'Move the summary before the supporting details.',
            copyText: 'Move the summary before the supporting details.',
          },
        });
      }
      return Promise.resolve([]);
    });
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<App />);
    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The report structure may need attention.',
        observation_id: 'obs-pinned',
        status: 'support_needed',
        ts: Date.now() / 1000,
      });
    });
    fireEvent.click(screen.getByText('Help me with this'));
    expect(
      await screen.findByText('Review the report structure'),
    ).toBeInTheDocument();

    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The user is continuing to work.',
        observation_id: 'obs-watching',
        status: 'observing',
        ts: Date.now() / 1000,
      });
    });

    expect(screen.getByText('Review the report structure')).toBeInTheDocument();
    expect(screen.queryByText('Watching')).not.toBeInTheDocument();
  });

  it('records watching observations without showing a bubble', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage: jest.fn(),
        invoke: jest.fn((channel: string) =>
          Promise.resolve(
            channel === 'get-coco-sleep-mode' ? { sleeping: false } : [],
          ),
        ),
      },
    };

    render(<App />);
    act(() => {
      listeners.get('observation-update')?.({
        type: 'snapshot',
        observation: 'The user is reading documentation.',
        observation_id: 'obs-watching-only',
        status: 'observing',
        ts: Date.now() / 1000,
      });
    });

    expect(screen.queryByText('Watching')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('The user is reading documentation.')).toBeInTheDocument();
  });

  it('uses the avatar as a drag surface and opens chat only from the menu', async () => {
    const sendMessage = jest.fn();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const invoke = jest.fn(
      (channel: string, payload?: { sleeping?: boolean }) => {
        if (channel === 'get-coco-sleep-mode')
          return Promise.resolve({ sleeping: false });
        return Promise.resolve({ success: true, sleeping: payload?.sleeping });
      },
    );
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(
          (channel: string, callback: (...args: unknown[]) => void) => {
            listeners.set(channel, callback);
            return () => listeners.delete(channel);
          },
        ),
        sendMessage,
        invoke,
      },
    };

    render(<App />);
    expect(screen.getByText('Right-click for menu')).toBeInTheDocument();
    expect(screen.getByTitle('More actions')).toHaveAttribute(
      'aria-label',
      'More actions',
    );
    const avatar = screen.getByAltText('Desktop Pet');
    const container = avatar.closest('.pet-container');
    const originalPointerEvent = Object.getOwnPropertyDescriptor(
      window,
      'PointerEvent',
    );
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: window.MouseEvent,
    });
    fireEvent.pointerDown(avatar, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 400,
    });
    fireEvent.pointerMove(container!, {
      pointerId: 1,
      screenX: 525,
      screenY: 415,
    });
    fireEvent.pointerUp(container!, {
      pointerId: 1,
      screenX: 525,
      screenY: 415,
    });
    expect(sendMessage).toHaveBeenCalledWith('avatar-drag-start', {
      screenX: 500,
      screenY: 400,
    });
    expect(sendMessage).toHaveBeenCalledWith('avatar-drag-move', {
      screenX: 525,
      screenY: 415,
    });
    expect(sendMessage).toHaveBeenCalledWith('avatar-drag-end');
    if (originalPointerEvent) {
      Object.defineProperty(window, 'PointerEvent', originalPointerEvent);
    } else {
      Reflect.deleteProperty(window, 'PointerEvent');
    }
    expect(screen.queryByTitle('Open the chat')).not.toBeInTheDocument();
    fireEvent.click(avatar);
    expect(sendMessage).not.toHaveBeenCalledWith('open-main-window');

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Open Chat'));
    expect(sendMessage).toHaveBeenCalledWith('open-main-window');

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Sleep'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set-coco-sleep-mode', {
        sleeping: true,
      });
    });

    fireEvent.click(screen.getByAltText('Desktop Pet'));
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

  it('provides History, Settings, Hide Avatar, and Quit menu actions', async () => {
    const sendMessage = jest.fn();
    const invoke = jest.fn((channel: string) =>
      Promise.resolve(
        channel === 'get-coco-sleep-mode' ? { sleeping: false } : { success: true },
      ),
    );
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage,
        invoke,
      },
    };

    render(<App />);
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Activity')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Settings'));
    expect(sendMessage).toHaveBeenCalledWith('open-chat-settings');

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Hide Avatar'));
    expect(invoke).toHaveBeenCalledWith('update-avatar-visibility', {
      hideAvatar: true,
    });

    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByText('Quit'));
    expect(sendMessage).toHaveBeenCalledWith('quit-app');
  });

  it('opens the same action menu when the avatar is right-clicked', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
        sendMessage: jest.fn(),
        invoke: jest.fn().mockResolvedValue({ sleeping: false }),
      },
    };

    render(<App />);
    fireEvent.contextMenu(screen.getByAltText('Desktop Pet'));

    expect(
      screen.getByRole('menu', { name: 'Coco actions' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('More actions'));
    act(() => listeners.get('open-avatar-actions-menu')?.());

    expect(
      screen.getByRole('menu', { name: 'Coco actions' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Open Chat')).toBeInTheDocument();
    expect(screen.getByText('Hide Avatar')).toBeInTheDocument();
    expect(screen.getByText('Quit')).toBeInTheDocument();
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
