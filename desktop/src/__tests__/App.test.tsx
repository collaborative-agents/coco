import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from '../renderer/App';
import ObservationBubble, {
  type BubbleState,
} from '../renderer/components/ObservationBubble';

// The bubble most recently sent to the bubble window.
const lastBubbleState = (sendMessage: jest.Mock) =>
  sendMessage.mock.calls
    .filter(([channel]) => channel === 'avatar-bubble-state')
    .at(-1)?.[1]?.bubble;

const mistakeEvent = () => ({
  type: 'snapshot',
  observation: 'The user may have made an error.',
  status: 'mistake',
  ts: Date.now() / 1000,
});

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
    const { sendMessage } = window.electron!.ipcRenderer as any;
    act(() => listeners.get('observation-update')?.(mistakeEvent()));
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ status: 'mistake' }),
    );

    act(() => listeners.get('system-suspend')?.());
    expect(lastBubbleState(sendMessage)).toBeNull();
  });

  const setupMenuIpc = (
    invoke: jest.Mock = jest.fn().mockResolvedValue({ sleeping: false }),
  ) => {
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
        invoke,
      },
    };
    const chooseMenuItem = (action: string) =>
      act(() => listeners.get('avatar-menu-action')?.(action));
    return { sendMessage, listeners, chooseMenuItem };
  };

  it('shows working updates briefly and clears them as soon as the run ends', async () => {
    jest.useFakeTimers();
    try {
      const { listeners, sendMessage } = setupMenuIpc();
      render(<App />);
      const target = {
        sessionId: 's',
        requestId: 'r',
        text: 'Checking results.',
      };
      await act(async () => listeners.get('agent-working')?.(target));
      expect(lastBubbleState(sendMessage)).toEqual(
        expect.objectContaining({
          tutorMessage: 'Checking results.',
          agentWorking: { sessionId: 's', requestId: 'r' },
        }),
      );
      expect(screen.getByAltText('Desktop Pet')).not.toHaveClass(
        'pet-image-awake',
      );
      act(() => jest.advanceTimersByTime(6000));
      expect(lastBubbleState(sendMessage)).toBeNull();
      act(() => listeners.get('agent-working')?.(target));
      act(() => listeners.get('agent-work-ended')?.({ requestId: 'r' }));
      expect(lastBubbleState(sendMessage)).toBeNull();
      // Final cleanup must not remove the completion reminder.
      act(() => listeners.get('agent-reply-ready')?.(target));
      act(() => listeners.get('agent-work-ended')?.({ requestId: 'r' }));
      expect(lastBubbleState(sendMessage)?.agentReply).toEqual(target);
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens the completed reply while asleep and clears its reminder', async () => {
    const { listeners, sendMessage } = setupMenuIpc();
    render(<App />);
    const target = { sessionId: 'session-1', requestId: 'request-1' };
    await act(async () => listeners.get('coco-sleep-mode-changed')?.({ sleeping: true }));
    await act(async () => listeners.get('agent-reply-ready')?.(target));
    await act(async () => listeners.get('coco-sleep-mode-changed')?.({ sleeping: true }));
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({
        agentReply: target,
        tutorMessage: 'Your reply is ready.',
        status: 'progress',
      }),
    );
    act(() => listeners.get('avatar-bubble-event')?.('view-conversation'));
    expect(sendMessage).toHaveBeenCalledWith('view-agent-reply', target);
    expect(lastBubbleState(sendMessage)).toBeNull();
  });

  it('expires ignored reply reminders without repeating or logging suggestion feedback', async () => {
    jest.useFakeTimers();
    try {
      const { listeners, sendMessage } = setupMenuIpc();
      render(<App />);
      await act(async () =>
        listeners.get('agent-reply-ready')?.({
          sessionId: 's',
          requestId: 'r',
        }),
      );
      act(() => listeners.get('avatar-bubble-event')?.('enter'));
      act(() => jest.advanceTimersByTime(3000));
      expect(screen.getByAltText('Desktop Pet')).not.toHaveClass(
        'pet-image-awake',
      );
      expect(lastBubbleState(sendMessage)).not.toBeNull();
      act(() => jest.advanceTimersByTime(5000));
      expect(screen.getByAltText('Desktop Pet')).toHaveClass('pet-image-awake');
      expect(lastBubbleState(sendMessage)).toBeNull();
      expect(sendMessage).not.toHaveBeenCalledWith(
        'training-feedback',
        expect.anything(),
      );
      act(() => jest.advanceTimersByTime(30000));
      expect(lastBubbleState(sendMessage)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('dismisses reply reminders without negative suggestion feedback', async () => {
    jest.useFakeTimers();
    try {
      const { listeners, sendMessage } = setupMenuIpc();
      render(<App />);
      await act(async () =>
        listeners.get('agent-reply-ready')?.({
          sessionId: 's',
          requestId: 'r',
        }),
      );
      act(() => listeners.get('avatar-bubble-event')?.('dismiss'));
      act(() => jest.advanceTimersByTime(400));
      expect(lastBubbleState(sendMessage)).toBeNull();
      expect(sendMessage).not.toHaveBeenCalledWith(
        'training-feedback',
        expect.anything(),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends a new bubble to its own window without resizing the avatar', () => {
    const { listeners, sendMessage } = setupMenuIpc();
    const { invoke } = window.electron!.ipcRenderer as any;

    render(<App />);
    act(() => listeners.get('observation-update')?.(mistakeEvent()));

    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({
        status: 'mistake',
        phrase: expect.any(String),
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'resize-avatar-window',
      expect.anything(),
    );
  });

  it('lets bubbles through again after sleeping with a suggestion open', async () => {
    const suggestion = {
      kind: 'content',
      title: 'Try a smaller example',
      body: 'Reduce the input first.',
      copyText: 'Reduce the input first.',
    };
    const invoke = jest.fn(async (channel: string, payload?: any) => {
      if (channel === 'get-instant-suggestion')
        return { status: 'ready', suggestion, scenario: 'everyday_support' };
      if (channel === 'set-coco-sleep-mode')
        return { success: true, sleeping: payload?.sleeping };
      return { sleeping: false };
    });
    const { listeners, sendMessage, chooseMenuItem } = setupMenuIpc(invoke);
    render(<App />);
    act(() => listeners.get('observation-update')?.(mistakeEvent()));
    // Reveal the suggestion, which pins the bubble.
    await act(async () => {
      listeners.get('avatar-bubble-event')?.('help');
    });
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ suggestion }),
    );

    await act(async () => chooseMenuItem('toggle-sleep'));
    expect(lastBubbleState(sendMessage)).toBeNull();
    act(() => listeners.get('observation-update')?.(mistakeEvent()));
    expect(lastBubbleState(sendMessage)).toBeNull();
    await act(async () => chooseMenuItem('toggle-sleep'));

    act(() =>
      listeners.get('observation-update')?.({
        ...mistakeEvent(),
        observation: 'A new observation after waking.',
        status: 'stuck',
      }),
    );
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ status: 'stuck' }),
    );
  });

  it('hides the ••• trigger while Coco is dragged', () => {
    const { listeners } = setupMenuIpc();
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    const container = trigger.closest('.pet-container');
    expect(container).not.toHaveClass('is-dragging');

    act(() => listeners.get('avatar-dragging')?.({ dragging: true }));
    expect(container).toHaveClass('is-dragging');
    act(() => listeners.get('avatar-dragging')?.({ dragging: false }));
    expect(container).not.toHaveClass('is-dragging');
  });

  it('handles clicks and hovers from the bubble window', async () => {
    jest.useFakeTimers();
    const { listeners, sendMessage } = setupMenuIpc();
    render(<App />);
    act(() => listeners.get('observation-update')?.(mistakeEvent()));
    const bubbleEvent = (type: string) =>
      act(() => listeners.get('avatar-bubble-event')?.(type));

    // Hovering pauses the auto-hide.
    bubbleEvent('enter');
    act(() => jest.advanceTimersByTime(60_000));
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ status: 'mistake', fadingOut: false }),
    );

    bubbleEvent('dismiss');
    expect(sendMessage).not.toHaveBeenCalledWith(
      'training-feedback',
      expect.objectContaining({ kind: 'dismiss', status: 'mistake' }),
    );
    act(() => jest.advanceTimersByTime(1_000));
    expect(lastBubbleState(sendMessage)).toBeNull();
    jest.useRealTimers();
  });

  it('keeps Coco asleep on avatar click and wakes it from the menu', async () => {
    const invoke = jest.fn(
      (channel: string, payload?: { sleeping?: boolean }) => {
        if (channel === 'get-coco-sleep-mode') {
          return Promise.resolve({ sleeping: false });
        }
        return Promise.resolve({ success: true, sleeping: payload?.sleeping });
      },
    );
    const { sendMessage, chooseMenuItem } = setupMenuIpc(invoke);

    render(<App />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('get-coco-sleep-mode');
    });
    chooseMenuItem('toggle-sleep');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set-coco-sleep-mode', {
        sleeping: true,
      });
    });

    // Let the sleep result settle before interacting again.
    await act(async () => {});
    fireEvent.click(screen.getByAltText('Desktop Pet'));
    expect(sendMessage).not.toHaveBeenCalledWith('open-main-window');
    expect(invoke).not.toHaveBeenCalledWith('set-coco-sleep-mode', {
      sleeping: false,
    });

    chooseMenuItem('toggle-sleep');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set-coco-sleep-mode', {
        sleeping: false,
      });
    });
  });

  it('asks main to open the menu from the ••• button and a right-click', () => {
    const { sendMessage, listeners } = setupMenuIpc();

    render(<App />);
    expect(screen.getByText('Right-click for menu')).toBeInTheDocument();
    const trigger = screen.getByTitle('More actions');
    fireEvent.click(trigger);
    expect(sendMessage).toHaveBeenCalledWith('open-avatar-menu');

    sendMessage.mockClear();
    fireEvent.contextMenu(
      screen.getByAltText('Desktop Pet').closest('.pet-container')!,
    );
    expect(sendMessage).toHaveBeenCalledWith('open-avatar-menu');

    act(() => listeners.get('avatar-menu-visibility')?.({ open: true }));
    expect(trigger).toHaveClass('is-open');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    act(() => listeners.get('avatar-menu-visibility')?.({ open: false }));
    expect(trigger).not.toHaveClass('is-open');
  });

  it('runs the navigation and Quit items chosen in the menu window', () => {
    const { sendMessage, chooseMenuItem } = setupMenuIpc();

    render(<App />);
    chooseMenuItem('open-main-window');
    expect(sendMessage).toHaveBeenCalledWith('open-main-window');
    chooseMenuItem('open-training');
    expect(sendMessage).toHaveBeenCalledWith('open-training');
    chooseMenuItem('open-chat-settings');
    expect(sendMessage).toHaveBeenCalledWith('open-chat-settings');
    chooseMenuItem('quit');
    expect(sendMessage).toHaveBeenCalledWith('quit-from-avatar');
  });
});

// The invite bubble is drawn in the bubble window from the state App sends it;
// clicks come back as avatar-bubble-event.
const renderBubbleWindow = (bubble: BubbleState | null | undefined) =>
  render(<ObservationBubble bubble={bubble ?? null} />);

describe('session invite bubble', () => {
  const setup = () => {
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
      listeners.get('session-invite')?.({
        inviteId: 'invite-1',
        taskLabel: 'Drafting a social media thread',
      });
    });
    const click = (type: string) =>
      act(() => listeners.get('avatar-bubble-event')?.(type));
    return { listeners, sendMessage, click };
  };

  it('shows the detected task and confirms it is on screen', () => {
    const { sendMessage } = setup();
    const bubble = lastBubbleState(sendMessage);
    expect(bubble).toEqual(
      expect.objectContaining({
        phrase: 'Drafting a social media thread',
        invite: { inviteId: 'invite-1', hasPreview: false },
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('session-invite-shown', {
      inviteId: 'invite-1',
    });

    const { getByText } = renderBubbleWindow(bubble);
    expect(getByText('Support available')).toBeInTheDocument();
    expect(getByText('Drafting a social media thread')).toBeInTheDocument();
  });

  it('starts the session from "Help me with this"', () => {
    const { sendMessage, click } = setup();
    click('help');
    expect(sendMessage).toHaveBeenCalledWith('session-invite-response', {
      inviteId: 'invite-1',
      outcome: 'accepted',
    });
    expect(lastBubbleState(sendMessage)).toBeNull();
  });

  it('reports a dismissal instead of training feedback', () => {
    const { sendMessage, click } = setup();
    click('dismiss');
    expect(sendMessage).toHaveBeenCalledWith('session-invite-response', {
      inviteId: 'invite-1',
      outcome: 'dismissed',
    });
    expect(
      sendMessage.mock.calls.some(
        ([channel]) => channel === 'training-feedback',
      ),
    ).toBe(false);
  });

  it('stays up through new observations until main clears it', () => {
    const { listeners, sendMessage } = setup();
    act(() => listeners.get('observation-update')?.(mistakeEvent()));
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ invite: expect.anything() }),
    );

    act(() => listeners.get('session-invite-clear')?.({ inviteId: 'other' }));
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ invite: expect.anything() }),
    );
    act(() =>
      listeners.get('session-invite-clear')?.({ inviteId: 'invite-1' }),
    );
    expect(lastBubbleState(sendMessage)).toBeNull();
  });

  it('hands a second invite back to main while the bubble is pinned', () => {
    const { listeners, sendMessage } = setup();
    act(() => {
      listeners.get('session-invite')?.({
        inviteId: 'invite-2',
        taskLabel: 'Something else',
      });
    });
    expect(sendMessage).toHaveBeenCalledWith('session-invite-busy', {
      inviteId: 'invite-2',
    });
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({ phrase: 'Drafting a social media thread' }),
    );
  });
});

describe('session invite with a suggestion preview', () => {
  const suggestion = {
    kind: 'content',
    title: 'Draft social media thread',
    body: 'Open with the main result, then one post per idea.',
    copyText: 'Open with the main result, then one post per idea.',
  };

  it('opens the preview in place and starts the session from chat', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sendMessage = jest.fn();
    const invoke = jest.fn(async (channel: string) =>
      channel === 'get-instant-suggestion'
        ? { status: 'ready', suggestion, scenario: 'everyday_support' }
        : [],
    );
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
      listeners.get('session-invite')?.({
        inviteId: 'invite-1',
        taskLabel: 'Announcing a blog post',
        observationId: 'invite-obs-1',
        rawObservation: 'The user is finishing a blog post.',
        suggestionTitle: 'Draft social media thread',
      });
    });
    expect(lastBubbleState(sendMessage)).toEqual(
      expect.objectContaining({
        phrase: 'Draft social media thread',
        invite: { inviteId: 'invite-1', hasPreview: true },
      }),
    );

    await act(async () => listeners.get('avatar-bubble-event')?.('help'));
    await waitFor(() =>
      expect(lastBubbleState(sendMessage)).toEqual(
        expect.objectContaining({ suggestion }),
      ),
    );
    expect(invoke).toHaveBeenCalledWith('get-instant-suggestion', {
      observationId: 'invite-obs-1',
    });
    expect(sendMessage).toHaveBeenCalledWith('session-invite-revealed', {
      inviteId: 'invite-1',
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      'session-invite-response',
      expect.anything(),
    );

    act(() => listeners.get('avatar-bubble-event')?.('chat'));
    expect(sendMessage).toHaveBeenCalledWith(
      'chat-about-suggestion',
      expect.objectContaining({
        observationId: 'invite-obs-1',
        sessionInviteId: 'invite-1',
        suggestion,
      }),
    );
  });
});
