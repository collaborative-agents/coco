import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import SessionChatView from '../renderer/components/SessionChatView';
// Existing tutor behavior tests run as an authorized study participant.
// Fail-closed policy behavior has its own useStudyAccess tests.
jest.mock('../renderer/useStudyAccess', () => ({
  __esModule: true,
  default: () => true,
}));
// Training's data and assessment flows are covered by TrainingView.test.tsx.
jest.mock('../renderer/components/TrainingView', () => ({
  __esModule: true,
  default: () => <div>Training task content</div>,
}));

describe('deferred suggestion context', () => {
  it('does not display the task banner for the active chat', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    await act(async () => {
      listeners.get('session-init')?.({
        sessionId: 'general-help',
        problemStatement: 'General help session',
      });
    });

    expect(screen.queryByText(/^Task:/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Coco/)).toBeInTheDocument();
  });

  it('shows only missing macOS permissions in Coco Health', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-system-permissions') {
        return {
          missing: [
            {
              target: 'accessibility',
              label: 'Accessibility',
              actionLabel: 'Open Accessibility',
              explanation: 'Accessibility is needed for activity detection.',
            },
          ],
        };
      }
      if (channel === 'open-system-permissions') return { success: true };
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
    fireEvent.click(screen.getByTitle('Settings'));

    expect(await screen.findByText('Coco Health')).toBeInTheDocument();
    expect(
      await screen.findByText('Accessibility permission required'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Screen Recording permission required'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Accessibility' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'open-system-permissions',
        'accessibility',
      );
    });
  });

  it('hides permission health when no system permissions are missing', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-system-permissions') return { missing: [] };
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
    fireEvent.click(screen.getByTitle('Settings'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('get-system-permissions');
    });
    expect(screen.queryByText(/permission required/i)).toBeNull();
  });

  it('shows only the four requested settings sections, without model or toolkit controls', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile')
        return { participantId: 'alex.user', userName: 'Alex' };
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
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('get-model-configuration'),
    );
    expect(
      screen.queryByRole('combobox', { name: 'Tutor model' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Settings'));

    expect(await screen.findByText('alex.user')).toBeInTheDocument();
    expect(screen.getByLabelText('What should Coco call you?')).toHaveValue(
      'Alex',
    );
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Account', 'Coco Health', 'Voice & desktop avatar', 'Memory']);
    [
      'Models & providers',
      'Agent mode',
      'AI Chatbots',
      'AI Agents',
      'Messages with participants',
    ].forEach((label) => {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('composer-model-selector'),
    ).not.toBeInTheDocument();
  });

  it('scales chat content without scaling the header', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-chat-content-zoom-factor') return 1;
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
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('get-chat-content-zoom-factor');
    });
    await act(async () => {
      listeners.get('chat-content-zoom-factor')?.(2);
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-scalable-content')).toHaveStyle({
        transform: 'scale(2)',
        width: '50%',
        height: '50%',
      });
    });
    expect(screen.getByRole('toolbar', { name: 'Chat actions' })).not.toHaveStyle({
      transform: 'scale(2)',
    });
  });

  it('shows sensing and tutor health independently and allows a refresh', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-coco-sleep-mode') return { sleeping: false };
      if (channel === 'get-service-health') {
        return {
          checkedAt: 1753200000000,
          sensing: {
            connected: true,
            status: 'healthy',
            totalActions: 12,
            modelAssessment: {
              status: 'verified',
              detail: 'Connected — text and image input accepted.',
            },
          },
          tutor: {
            connected: false,
            status: 'unavailable',
            detail: 'Service is not running.',
            modelAssessment: {
              status: 'failed',
              detail: 'The tutor model rejected the API key.',
            },
          },
        };
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
      screen.getByTitle('Settings'),
    );

    expect(
      await screen.findByLabelText(
        'Sensing server: Connected (service); Connected (model)',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        'Tutor agent: Not connected (service); Not connected (model)',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/actions processed/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/text and image input accepted/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Service is not running/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === 'get-service-health',
        ),
      ).toHaveLength(2);
      expect(invoke).toHaveBeenLastCalledWith('get-service-health', {
        forceModelTest: true,
      });
    });
  });

  it('shows sleep state without checking intentionally stopped services', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-coco-sleep-mode') return { sleeping: true };
      if (channel === 'get-service-health') {
        const service = {
          connected: true,
          status: 'healthy',
          modelAssessment: { status: 'verified', detail: 'Connected.' },
        };
        return { checkedAt: Date.now(), sensing: service, tutor: service };
      }
      return null;
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (...args: any[]) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke,
      },
    };

    render(<SessionChatView />);

    fireEvent.click(screen.getByTitle('Settings'));
    expect(
      await screen.findByText(
        'Sleeping intentionally stops the sensing server and tutor agent.',
      ),
    ).toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'get-service-health'),
    ).toHaveLength(0);

    await act(async () => {
      listeners.get('coco-sleep-mode-changed')?.({ sleeping: false });
    });
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === 'get-service-health',
        ),
      ).toHaveLength(1);
    });
  });

  it('shows missing model configuration in Settings', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-coco-sleep-mode') return { sleeping: false };
      if (channel === 'get-service-health') {
        const modelAssessment = {
          status: 'not_configured',
          detail: 'No model configuration was found.',
        };
        return {
          checkedAt: 1753200000000,
          sensing: { connected: true, status: 'healthy', modelAssessment },
          tutor: { connected: true, status: 'healthy', modelAssessment },
        };
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
    fireEvent.click(screen.getByTitle('Settings'));
    expect(screen.getByText('Coco Health')).toBeInTheDocument();
    expect(
      await screen.findAllByText(/No model configuration was found/),
    ).toHaveLength(2);
  });

  it('shows a failed real model check in the chat header', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-coco-sleep-mode') return { sleeping: false };
      if (channel === 'get-service-health') {
        return {
          checkedAt: 1753200000000,
          sensing: {
            connected: true,
            status: 'healthy',
            modelAssessment: {
              status: 'verified',
              detail: 'Connected — text and image input accepted.',
            },
          },
          tutor: {
            connected: true,
            status: 'healthy',
            modelAssessment: {
              status: 'failed',
              detail: 'The API key was rejected.',
            },
          },
        };
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
    fireEvent.click(screen.getByTitle('Settings'));
    expect(
      await screen.findByText(/The API key was rejected/),
    ).toBeInTheDocument();
  });

  it('applies desktop avatar visibility immediately', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return {
          tutorScenario: 'everyday_support',
          aiTools: [],
          hideAvatar: false,
        };
      }
      if (channel === 'update-avatar-visibility') {
        return { success: true };
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
    fireEvent.click(screen.getByTitle('Settings'));
    const checkbox = screen.getByRole('switch', {
      name: 'Desktop avatar',
    });
    fireEvent.click(checkbox);

    expect(checkbox).not.toBeChecked();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update-avatar-visibility', {
        hideAvatar: true,
      });
      expect(
        screen.queryByRole('button', { name: 'Save changes' }),
      ).not.toBeInTheDocument();
    });
  });

  it('opens the settings panel from the tray event', async () => {
    const listeners = new Map<string, (data?: unknown) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data?: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    expect(screen.queryByText('Models & providers')).not.toBeInTheDocument();

    await act(async () => {
      listeners.get('open-chat-settings')?.();
    });

    expect(
      screen.getByRole('heading', { name: 'Account' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Coco Health')).toBeInTheDocument();
  });

  it('opens and resumes a past conversation from the hover sidebar', async () => {
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
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Chat' }));

    expect(await screen.findByText('Launch checklist')).toBeInTheDocument();
    expect(screen.getByText('What should I do first?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Launch checklist'));
    expect(
      screen.getByText('Start by naming the launch owner.'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Coco/)).toBeInTheDocument();
    expect(
      screen.queryByText('Viewing a past conversation'),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('get-agent-workspace', {
        sessionId: 'past-session',
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Choose working folder' }),
    ).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText(/Ask Coco/), {
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

  it('keeps only chat and training navigation plus bottom settings in the rail', () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    const actions = [
      screen.getByRole('button', { name: 'Start a new session' }),
      screen.getByRole('button', { name: 'Collapse' }),
      screen.getByRole('button', { name: 'Close' }),
    ];

    actions.forEach((action) =>
      expect(action).toHaveStyle({
        display: 'inline-flex',
        alignItems: 'center',
      }),
    );
    const rail = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(rail).getAllByRole('button')).toHaveLength(3);
    expect(
      within(rail).getByRole('button', { name: 'Chat' }),
    ).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: 'Settings' })).toHaveClass(
      'workspace-settings-button',
    );
    expect(
      screen
        .getByRole('button', { name: 'Personalization' })
        .querySelector('[data-header-icon="todo"]'),
    ).toBeInTheDocument();
  });

  it('restores the active transcript after a renderer reload', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
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

    fireEvent.click(screen.getByRole('button', { name: 'Copy tutor message' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        savedConversation.messages[1].text.trim(),
      );
      expect(screen.getByText('Copied ✓')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy user message' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith(
        savedConversation.messages[0].text,
      );
    });
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
    expect(screen.getByPlaceholderText(/Ask Coco/)).toHaveValue('');
    expect(invoke).not.toHaveBeenCalledWith(
      'send-chat-message',
      expect.anything(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Ask Coco/), {
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

    fireEvent.change(screen.getByPlaceholderText(/Ask Coco/), {
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

  it('lets AI Fluency Upskilling users manually open the session recap', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return { tutorScenario: 'ai_upskilling', aiTools: [] };
      }
      if (channel === 'get-supported-modes') return ['ai_upskilling'];
      if (channel === 'check-understanding') return { success: true };
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
    const checkUnderstanding = await screen.findByRole('button', {
      name: 'Check my understanding',
    });
    expect(checkUnderstanding).toHaveAttribute(
      'title',
      'Check what you learned with a short quiz. Your conversation stays open.',
    );
    expect(checkUnderstanding.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    fireEvent.click(checkUnderstanding);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('check-understanding', {
        sessionId: null,
      });
    });
  });

  it.each([true, false])(
    'checks the selected conversation without resuming it (check succeeds: %s)',
    async (success) => {
      let finishRestore: (result: unknown) => void = () => {};
      const restore = new Promise((resolve) => {
        finishRestore = resolve;
      });
      const invoke = jest.fn(async (channel: string) => {
        if (channel === 'get-profile')
          return { tutorScenario: 'ai_upskilling', aiTools: [] };
        if (channel === 'get-supported-modes') return ['ai_upskilling'];
        if (channel === 'get-chat-conversations')
          return [
            {
              sessionId: 'past-quiz-session',
              title: 'Past lesson',
              problem: 'Practice context',
              createdAt: 1,
              updatedAt: 2,
              messages: [
                { role: 'user', text: 'Help with context' },
                { role: 'tutor', text: 'Describe your constraints.' },
              ],
            },
          ];
        if (channel === 'check-understanding') return restore;
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
      await screen.findByRole('button', { name: 'Check my understanding' });
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Chat' }));
      fireEvent.click(await screen.findByText('Past lesson'));
      expect(
        screen.getByText('Describe your constraints.'),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'Check my understanding' }),
      );
      expect(invoke).toHaveBeenCalledWith('check-understanding', {
        sessionId: 'past-quiz-session',
      });
      expect(
        invoke.mock.calls.some(
          ([channel]) => channel === 'resume-chat-conversation',
        ),
      ).toBe(false);
      await act(async () => {
        finishRestore({
          success,
          error: success ? undefined : 'Could not open quiz.',
        });
      });
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === 'check-understanding',
        ),
      ).toHaveLength(1);
      expect(Boolean(screen.queryByText('Could not open quiz.'))).toBe(
        !success,
      );
    },
  );

  it('allows an understanding check without discarding an unsent draft', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return { tutorScenario: 'ai_upskilling', aiTools: [] };
      }
      if (channel === 'get-supported-modes') return ['ai_upskilling'];
      if (channel === 'check-understanding') return { success: true };
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
    const finish = await screen.findByRole('button', {
      name: 'Check my understanding',
    });
    const inputBox = screen.getByPlaceholderText(/Ask Coco/);

    fireEvent.change(inputBox, { target: { value: 'Help with this draft' } });
    expect(finish).toBeEnabled();
    fireEvent.click(finish);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('check-understanding', {
        sessionId: null,
      }),
    );
    expect(inputBox).toHaveValue('Help with this draft');

    fireEvent.change(inputBox, { target: { value: '' } });
    expect(finish).toBeEnabled();
  });

  it('shows a highlighted screen prompt and two secondary suggestions', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return { tutorScenario: 'ai_upskilling', aiTools: [] };
      }
      if (channel === 'get-supported-modes') return ['ai_upskilling'];
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

    const starter = await screen.findByRole('button', {
      name: 'Help me with the current ask on my screen',
    });
    expect(starter).toHaveStyle({ fontWeight: 700 });
    expect(
      screen.queryByRole('button', {
        name: 'Show me how to ask AI for a useful first draft.',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Review my recent work activity to find one part that AI could handle.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Suggest something useful to learn.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Suggest tasks for me/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Or try an example')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Find something useful to do or learn/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '✓ Finish' }),
    ).not.toBeInTheDocument();
  });

  it.each([
    'Help me with the current ask on my screen',
    'Review my recent work activity to find one part that AI could handle.',
    'Suggest something useful to learn.',
  ])('sends the prompt "%s" as an ordinary chat request', async (prompt) => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return { tutorScenario: 'ai_upskilling', aiTools: [] };
      }
      if (channel === 'get-supported-modes') return ['ai_upskilling'];
      if (channel === 'send-chat-message') {
        return { guidance: 'Let’s look at your current task.' };
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
    fireEvent.click(await screen.findByRole('button', { name: prompt }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({
          userText: prompt,
          requestKind: 'chat',
        }),
      );
    });
    expect(screen.getByText(prompt)).toBeInTheDocument();
  });

  it('does not show the manual recap control in other modes', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return { tutorScenario: 'everyday_support', aiTools: [] };
      }
      if (channel === 'get-supported-modes') return ['everyday_support'];
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get-profile'));
    expect(
      screen.queryByRole('button', { name: 'Check my understanding' }),
    ).not.toBeInTheDocument();
  });

  it('opens desktop previews for pending and sent image attachments', async () => {
    const listeners = new Map<string, (data: any) => void>();
    const sendMessage = jest.fn();
    const healthyService = {
      connected: true,
      status: 'healthy',
      modelAssessment: { status: 'verified', detail: 'Connected.' },
    };
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-model-configuration') {
        return {
          sensing: {
            id: 'sensing',
            label: 'Sensing',
            provider: 'gemini',
            model: 'gemini/vision',
          },
          tutors: [
            {
              id: 'primary',
              label: 'Primary',
              provider: 'anthropic',
              model: 'anthropic/tutor',
            },
          ],
          defaultTutorId: 'primary',
        };
      }
      if (channel === 'get-service-health') {
        return {
          checkedAt: Date.now(),
          sensing: healthyService,
          tutor: healthyService,
        };
      }
      if (channel === 'send-chat-message') {
        return { guidance: 'I can see the attachment.' };
      }
      return null;
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: any) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage,
        invoke,
      },
    };
    render(<SessionChatView />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('get-model-configuration'),
    );

    const imageDataUrl = 'data:image/png;base64,cHJldmlldw==';
    act(() => {
      listeners.get('hotkey-capture')?.({ imageDataUrl });
    });
    sendMessage.mockClear();

    fireEvent.click(
      screen.getByRole('button', { name: 'Preview attached image 1' }),
    );
    expect(sendMessage).toHaveBeenCalledWith('open-image-preview', {
      imageDataUrl,
    });
    sendMessage.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({
          images: [imageDataUrl],
          hotkeyImages: [imageDataUrl],
        }),
      );
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Preview message attachment 1',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('open-image-preview', {
      imageDataUrl,
    });
  });
});
