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
  it('disables voice input for text-only tutors without disabling wake-word detection', async () => {
    const listeners = new Map<string, (data: any) => void>();
    const sendMessage = jest.fn();
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
              id: 'text-only',
              label: 'Text only',
              provider: 'anthropic',
              model: 'anthropic/claude-sonnet',
              supportsAudio: false,
            },
            {
              id: 'voice',
              label: 'Voice tutor',
              provider: 'openai',
              model: 'openai/gpt-audio',
              supportsAudio: true,
            },
          ],
          defaultTutorId: 'text-only',
        };
      }
      if (channel === 'set-chat-model') {
        return { success: true, modelId: 'voice' };
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

    const disabledMic = await screen.findByRole('button', {
      name: /Voice input unavailable/,
    });
    expect(disabledMic).toBeDisabled();

    await act(async () => {
      listeners.get('wake-word-detected')?.({ id: 17 });
    });
    expect(sendMessage).toHaveBeenCalledWith('wake-word-detection-ack', {
      id: 17,
    });
    expect(invoke).toHaveBeenCalledWith('set-wake-word-capture-paused', {
      paused: false,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'send-audio-message',
      expect.anything(),
    );
    expect(
      await screen.findByText(
        /Coco is awake, but the selected tutor does not support audio input/,
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Tutor model' }), {
      target: { value: 'voice' },
    });
    expect(
      await screen.findByRole('button', { name: 'Start voice recording' }),
    ).toBeEnabled();
  });

  it('auto-grows long prompts and lets the user expand the message editor', async () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    const editor = screen.getByPlaceholderText(/Ask the tutor/);
    let simulatedScrollHeight = 190;
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: () => simulatedScrollHeight,
    });

    fireEvent.change(editor, {
      target: { value: 'A long prompt\n'.repeat(20) },
    });

    const expand = await screen.findByRole('button', {
      name: 'Expand message editor',
    });
    expect(editor).toHaveStyle({ height: '120px', overflowY: 'auto' });

    fireEvent.click(expand);
    await waitFor(() => {
      expect(editor).toHaveStyle({ height: '190px', overflowY: 'hidden' });
    });
    expect(
      screen.getByRole('button', { name: 'Collapse message editor' }),
    ).toHaveAttribute('aria-expanded', 'true');

    simulatedScrollHeight = 60;
    fireEvent.change(editor, { target: { value: 'Short prompt' } });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Collapse message editor' }),
      ).not.toBeInTheDocument();
    });
    expect(editor).toHaveStyle({ height: '60px', overflowY: 'hidden' });
  });

  it('does not send when Enter confirms text from an IME', async () => {
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'send-chat-message') {
        return { guidance: 'Response' };
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
    const editor = screen.getByPlaceholderText(/Ask the tutor/);
    fireEvent.change(editor, { target: { value: 'English' } });

    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });

    expect(editor).toHaveValue('English');
    expect(invoke).not.toHaveBeenCalledWith(
      'send-chat-message',
      expect.anything(),
    );

    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({ userText: 'English' }),
      );
    });
  });

  it('shows editable model settings when no saved configuration is available', async () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    fireEvent.click(screen.getByTitle('Settings'));

    expect(screen.getByText('Models & providers')).toBeInTheDocument();
    expect(
      await screen.findByText(/No saved model configuration was found/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Vision-capable sensing model'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Tutor model ID')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Supports audio input' }),
    ).not.toBeChecked();
    expect(
      screen.getByText(/Configure multiple models, choose a default/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save model settings' }),
    ).toBeEnabled();
  });

  it('keeps the tutor selector width fixed and exposes full model details', async () => {
    const invoke = jest.fn(async (channel: string, payload?: any) => {
      if (channel === 'get-model-configuration') {
        return {
          sensing: {
            id: 'sensing',
            label: 'Sensing',
            provider: 'gemini',
            model: 'gemini/gemini-vision',
          },
          tutors: [{
            id: 'primary',
            label: 'A much longer primary tutor display name',
            provider: 'hosted_vllm',
            model: 'hosted_vllm/org/tutor-model',
            baseUrl: 'https://models.example.test/v1',
          }],
          defaultTutorId: 'primary',
        };
      }
      if (channel === 'test-model-connection') {
        return {
          success: true,
          message: payload.role === 'sensing'
            ? 'Connected — text and image input accepted.'
            : 'Connected — text input accepted.',
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
    const selector = await screen.findByRole('combobox', {
      name: 'Tutor model',
    });

    expect(selector).toHaveStyle({ width: '120px' });
    expect(screen.getByRole('banner')).not.toContainElement(selector);
    expect(screen.getByTestId('composer-model-selector')).toContainElement(selector);
    expect(selector).toHaveAttribute(
      'title',
      expect.stringContaining('A much longer primary tutor display name'),
    );
    expect(selector).toHaveAttribute(
      'title',
      expect.stringContaining('Provider: OpenAI-compatible endpoint'),
    );
    expect(selector).toHaveAttribute(
      'title',
      expect.stringContaining('Model: org/tutor-model'),
    );
    expect(selector).toHaveAttribute(
      'title',
      expect.stringContaining('Endpoint: https://models.example.test/v1'),
    );

    fireEvent.click(screen.getByTitle('Settings'));
    fireEvent.click(await screen.findByRole('button', {
      name: 'Test sensing model connection',
    }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'test-model-connection',
        expect.objectContaining({
          role: 'sensing',
          connection: expect.objectContaining({
            model: 'gemini/gemini-vision',
          }),
        }),
      );
      expect(
        screen.getByText('Connected — text and image input accepted.'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', {
      name: 'Test A much longer primary tutor display name connection',
    }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'test-model-connection',
        expect.objectContaining({
          role: 'tutor',
          connection: expect.objectContaining({
            model: 'org/tutor-model',
          }),
        }),
      );
      expect(screen.getByText('Connected — text input accepted.'))
        .toBeInTheDocument();
    });
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
    expect(screen.getByRole('banner')).not.toHaveStyle({
      transform: 'scale(2)',
    });
  });

  it('shows sensing and tutor health independently and allows a refresh', async () => {
    const invoke = jest.fn(async (channel: string) => {
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
      await screen.findByRole('button', {
        name: 'Service issue. Open Settings',
      }),
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
    expect(screen.getByText(/text and image input accepted/)).toBeInTheDocument();
    expect(screen.getByText(/Service is not running/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'get-service-health'),
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

    expect(
      await screen.findByRole('status', { name: 'Sleeping' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Settings'));
    expect(
      screen.getByText(
        /Sleeping intentionally stops screen observation while the tutor stays available/,
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

  it('shows missing model configuration in the chat header', async () => {
    const invoke = jest.fn(async (channel: string) => {
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
    const warning = await screen.findByRole('button', {
      name: 'Configure models. Open Settings',
    });
    expect(warning).toHaveStyle({ color: '#b45309' });

    fireEvent.click(warning);
    expect(screen.getByText('Models & providers')).toBeInTheDocument();
    expect(
      await screen.findByText(/No saved model configuration was found/),
    ).toBeInTheDocument();
  });

  it('shows a failed real model check in the chat header', async () => {
    const invoke = jest.fn(async (channel: string) => {
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
    const warning = await screen.findByRole('button', {
      name: 'Model issue. Open Settings',
    });
    expect(warning).toHaveStyle({ color: '#dc2626' });
    expect(warning).toHaveAttribute(
      'title',
      expect.stringContaining('The API key was rejected.'),
    );
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
    const checkbox = screen.getByRole('checkbox', {
      name: /Hide desktop avatar/,
    });
    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update-avatar-visibility', {
        hideAvatar: true,
      });
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });
  });

  it('shows the signed-in user and logs out from Settings', async () => {
    const sendMessage = jest.fn();
    const invoke = jest.fn(async (channel: string) => {
      if (channel === 'get-profile') {
        return {
          userName: 'Ada',
          participantId: 'participant-1',
          tutorScenario: 'everyday_support',
          aiTools: [],
          hideAvatar: false,
        };
      }
      return null;
    });
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage,
        invoke,
      },
    };

    render(<SessionChatView />);
    fireEvent.click(screen.getByTitle('Settings'));

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Username: participant-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(sendMessage).toHaveBeenCalledWith('auth-logout');
  });

  it('keeps the Social and messages button the same size as other header buttons', () => {
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn(() => jest.fn()),
        sendMessage: jest.fn(),
        invoke: jest.fn(async () => null),
      },
    };

    render(<SessionChatView />);
    const socialButton = screen.getByRole('button', {
      name: 'Social and messages',
    });
    const settingsButton = screen.getByTitle('Settings');

    expect(socialButton).toHaveStyle({ width: '26px', height: '25px' });
    expect(settingsButton).toHaveStyle({ width: '26px', height: '25px' });
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

    expect(screen.getByText('Models & providers')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
  });

  it('opens the Friends panel from an avatar notification', async () => {
    const listeners = new Map<string, (data?: unknown) => void>();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data?: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage: jest.fn(),
        invoke: jest.fn(async (channel: string) => {
          if (channel === 'social-list-friendships') {
            return { friends: [], incoming: [], outgoing: [] };
          }
          if (channel === 'social-list-knowledge-requests') {
            return { incoming: [], outgoing: [] };
          }
          return null;
        }),
      },
    };

    render(<SessionChatView />);
    await act(async () => {
      listeners.get('open-social-inbox')?.();
    });

    expect(screen.getAllByText('Friends').length).toBeGreaterThan(0);
    expect(
      screen.getByPlaceholderText('Add by participant ID'),
    ).toBeInTheDocument();
  });

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
      expect(writeText).toHaveBeenLastCalledWith(savedConversation.messages[0].text);
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

  it('places an Open Coco Chat delegation prompt in the chat input', () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const invoke = jest.fn(async () => null);

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
        phrase: 'Ask an AI tool',
        rawObservation: 'The user encountered an error.',
        initialInput: 'Explain this error and suggest a fix.',
      });
    });

    expect(screen.getByPlaceholderText(/Ask the tutor/)).toHaveValue(
      'Explain this error and suggest a fix.',
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'send-chat-message',
      expect.anything(),
    );
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
    await screen.findByRole('combobox', { name: 'Tutor model' });

    const imageDataUrl = 'data:image/png;base64,cHJldmlldw==';
    act(() => {
      listeners.get('hotkey-capture')?.({ imageDataUrl });
    });
    sendMessage.mockClear();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Preview attached image 1',
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith('open-image-preview', {
      imageDataUrl,
    });
    sendMessage.mockClear();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Annotate hotkey screenshot 1',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('open-image-preview', {
      imageDataUrl,
      editable: true,
    });

    const annotatedImageDataUrl = 'data:image/png;base64,YW5ub3RhdGVk';
    act(() => {
      listeners.get('image-annotation-saved')?.({
        originalImageDataUrl: imageDataUrl,
        imageDataUrl: annotatedImageDataUrl,
      });
    });
    expect(screen.getByAltText('Attachment 1')).toHaveAttribute(
      'src',
      annotatedImageDataUrl,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'send-chat-message',
        expect.objectContaining({
          images: [annotatedImageDataUrl],
          hotkeyImages: [annotatedImageDataUrl],
        }),
      );
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Preview message attachment 1',
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith('open-image-preview', {
      imageDataUrl: annotatedImageDataUrl,
    });
  });
});
