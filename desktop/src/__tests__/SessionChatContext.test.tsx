import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import SessionChatView from '../renderer/components/SessionChatView';

describe('deferred suggestion context', () => {
  it('opens and resumes a past conversation from the chat header', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-chat-conversations') {
        return [
          {
            sessionId: 'past-session',
            title: 'Launch checklist',
            problem: 'Plan the launch',
            createdAt: 1753200000000,
            updatedAt: 1753203600000,
            messages: [
              { role: 'user', text: 'What should I do first?' },
              { role: 'tutor', text: 'Start by naming the launch owner.' },
            ],
          },
        ];
      }
      if (channel === 'resume-chat-conversation') {
        return { success: true };
      }
      if (channel === 'send-chat-message') {
        return { guidance: 'Continue by setting a launch date.' };
      }
      return null;
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<SessionChatView />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review past conversations' }),
    );

    expect(await screen.findByText('Launch checklist')).toBeInTheDocument();
    expect(screen.getByText('What should I do first?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Launch checklist'));
    expect(
      screen.getByText('Start by naming the launch owner.'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask the tutor/)).toBeInTheDocument();
    expect(screen.getByText('Viewing a past conversation')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Ask the tutor/), {
      target: { value: 'What should I do next?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('resume-chat-conversation', {
        sessionId: 'past-session',
      });
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({ userText: 'What should I do next?' }),
      );
    });
    expect(screen.getByText('What should I do first?')).toBeInTheDocument();
    expect(screen.getByText('What should I do next?')).toBeInTheDocument();
    expect(
      screen.queryByText('Viewing a past conversation'),
    ).not.toBeInTheDocument();
  });

  it('starts a fresh chat session from the header', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const invoke = jest.fn(async () => ({ success: true }));

    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<SessionChatView />);

    act(() => {
      listeners.get('session-init')?.({
        sessionId: 'old-session',
        problemStatement: 'Draft a project plan',
      });
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Start a new session' }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('start-new-chat-session', {
        problemStatement: 'Draft a project plan',
      });
    });
  });

  it('restores the active transcript after a renderer reload', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const savedConversation = {
      sessionId: 'active-session',
      problem: 'Review prior literature',
      createdAt: 1753200000000,
      updatedAt: 1753203600000,
      messages: [
        { role: 'user', text: 'What does previous work fall short of?' },
        {
          role: 'tutor',
          text:
            'Prior work often assumes memory is already available.\n\n' +
            '```python\nfrom huggingface_hub import snapshot_download\n```\n',
        },
      ],
    };
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-chat-conversations') return [savedConversation];
      return null;
    });

    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<SessionChatView />);
    act(() => {
      listeners.get('session-init')?.({
        sessionId: 'active-session',
        problemStatement: 'Review prior literature',
      });
    });

    expect(
      await screen.findByText('What does previous work fall short of?'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Prior work often assumes memory is already available.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('from huggingface_hub import snapshot_download'),
    ).toBeInTheDocument();
  });

  it('waits for the user to send a message before calling the tutor', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const invoke = jest.fn(async (channel: string, _payload?: unknown) => {
      if (channel === 'send-chat-message') {
        return { guidance: 'Let’s discuss it.' };
      }
      return null;
    });

    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<SessionChatView />);

    act(() => {
      listeners.get('help-request')?.({
        phrase: 'Try a smaller example',
        label: 'Suggestion',
        rawObservation:
          'Suggestion: reduce the input.\n\nObservation: the full workflow is failing.',
        deferUntilUserMessage: true,
      });
    });

    expect(
      screen.getByText('Suggestion context attached: Try a smaller example'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask the tutor/)).toHaveValue('');
    expect(invoke).not.toHaveBeenCalledWith(
      'send-chat-message',
      expect.anything(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Ask the tutor/), {
      target: { value: 'Why would that help?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({
          userText: expect.stringContaining('Suggestion: reduce the input.'),
        }),
      );
    });
    const tutorPayload = invoke.mock.calls.find(
      ([channel]) => channel === 'send-chat-message',
    )?.[1] as { userText: string };
    expect(tutorPayload.userText).toContain(
      'Observation: the full workflow is failing.',
    );
    expect(tutorPayload.userText).toContain(
      'The user now says:\nWhy would that help?',
    );
    expect(screen.getByText('Why would that help?')).toBeInTheDocument();
    expect(
      screen.queryByText(/Suggestion context attached/),
    ).not.toBeInTheDocument();
  });

  it('renders streamed text and tool-call lifecycle events in one reply', async () => {
    const listeners = new Map<string, (data: any) => void>();
    let requestId = '';
    const invoke = jest.fn(async (channel: string, payload?: any) => {
      if (channel === 'send-chat-message') {
        requestId = payload.requestId;
        return { streamed: true };
      }
      return null;
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: any) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke,
      },
    };
    render(<SessionChatView />);

    fireEvent.change(screen.getByPlaceholderText(/Ask the tutor/), {
      target: { value: 'What was I working on?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(requestId).not.toBe(''));

    act(() => {
      listeners.get('chat-stream-event')?.({
        requestId,
        type: 'tool_call_started',
        call: {
          id: 'tool-1',
          name: 'get_user_context',
          arguments: { query: 'roadmap', limit: 3, evidence_limit: 1 },
          status: 'running',
        },
      });
    });
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByText('Coco is thinking…')).not.toBeInTheDocument();

    act(() => {
      listeners.get('chat-stream-event')?.({
        requestId,
        type: 'tool_call_completed',
        call: {
          id: 'tool-1',
          name: 'get_user_context',
          arguments: { query: 'roadmap', limit: 3, evidence_limit: 1 },
          status: 'completed',
          result: { count: 1, results: [] },
        },
      });
      listeners.get('chat-stream-event')?.({
        requestId,
        type: 'text_delta',
        text: 'Your roadmap ',
      });
      listeners.get('chat-stream-event')?.({
        requestId,
        type: 'text_delta',
        text: 'was open.',
      });
    });
    expect(screen.getByText('1 found')).toBeInTheDocument();
    expect(screen.getByText('Your roadmap was open.')).toBeInTheDocument();

    act(() => {
      listeners.get('chat-stream-event')?.({
        requestId,
        type: 'done',
        guidance: 'Your roadmap was open.',
        llm_metrics: { total_tokens: 12 },
        tool_calls: [],
      });
    });
    expect(screen.queryByText('Coco is thinking…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
  });
});
