import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import PiProviderSettings from '../renderer/components/chat/PiProviderSettings';
import LocalModelSettings from '../renderer/components/chat/LocalModelSettings';
import OnboardingView from '../renderer/components/OnboardingView';

function setup(config: any = null) {
  const status = {
    connection: { mode: 'coco' },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        oauth: 'Sign in with OpenAI',
        connected: true,
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        apiKey: 'API key',
        connected: false,
      },
    ],
    models: [
      {
        provider: 'openai',
        id: 'vision/model',
        name: 'Vision model',
        input: ['text', 'image'],
        thinkingLevels: ['low', 'medium', 'high'],
      },
      {
        provider: 'openai',
        id: 'text-model',
        name: 'Text model',
        input: ['text'],
      },
      {
        provider: 'anthropic',
        id: 'claude',
        name: 'Claude',
        input: ['text', 'image'],
      },
    ],
    flow: null,
  };
  const invoke = jest.fn(async (channel, action, payload) => {
    if (channel === 'get-model-configuration') return config;
    if (channel === 'save-model-configuration') return { success: true };
    if (channel !== 'pi-provider') return null;
    if (action === 'login') {
      status.providers.find(
        (provider) => provider.id === payload.provider,
      )!.connected = true;
    }
    return { ...status };
  });
  (window as any).electron = {
    ipcRenderer: { invoke, sendMessage: jest.fn() },
  };
  return { invoke, status };
}

test('uses provider names for login and cancels authentication on close', async () => {
  const { invoke } = setup();
  const view = render(<PiProviderSettings />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Sign in with OpenAI' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('pi-provider', 'login', {
      provider: 'openai',
      type: 'oauth',
    }),
  );
  expect(view.container.textContent).not.toMatch(/\bPi\b/);
  view.unmount();
  expect(invoke).toHaveBeenCalledWith('pi-provider', 'cancel', undefined);
});

test('saves provider and endpoint models together with their existing routing', async () => {
  const { invoke } = setup();
  const view = render(<LocalModelSettings />);
  await screen.findByRole('option', { name: 'OpenAI — connected' });
  fireEvent.click(screen.getByRole('button', { name: '+ Add model' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat provider' }), {
    target: { value: 'catalog:openai' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat model' }), {
    target: { value: 'pi/openai/vision/model' },
  });
  fireEvent.click(screen.getByRole('button', { name: '+ Add model' }));
  fireEvent.change(
    screen.getAllByRole('combobox', { name: 'Chat provider' })[1],
    {
      target: { value: 'hosted_vllm' },
    },
  );
  fireEvent.change(screen.getAllByLabelText('Model display name')[1], {
    target: { value: 'My server' },
  });
  fireEvent.change(screen.getByLabelText('Chat model ID'), {
    target: { value: 'my-model' },
  });
  fireEvent.change(
    screen.getByPlaceholderText('OpenAI-compatible base URL, ending in /v1'),
    {
      target: { value: 'https://example.test/v1' },
    },
  );
  fireEvent.change(screen.getByPlaceholderText('API key (optional)'), {
    target: { value: 'secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'save-model-configuration',
      expect.objectContaining({
        tutors: [
          expect.objectContaining({
            provider: 'pi',
            model: 'pi/openai/vision/model',
            label: 'Vision model',
          }),
          expect.objectContaining({
            provider: 'hosted_vllm',
            model: 'my-model',
            baseUrl: 'https://example.test/v1',
          }),
        ],
      }),
    ),
  );
  const saved = invoke.mock.calls.find(
    ([channel]) => channel === 'save-model-configuration',
  )![1];
  expect(saved.defaultTutorId).toBe(saved.tutors[0].id);
  expect(saved.credentials[`tutor:hosted_vllm:${saved.tutors[1].id}`]).toBe(
    'secret',
  );
  expect(
    saved.tutors.every((model: any) => !('catalogProvider' in model)),
  ).toBe(true);
  expect(view.container.textContent).not.toMatch(
    /\bPi\b|Additional model connections/,
  );
});

test('opens the selected provider account and keeps sensing limited to vision models', async () => {
  setup();
  render(<LocalModelSettings />);
  await screen.findByRole('option', { name: 'OpenAI — connected' });
  fireEvent.click(screen.getByRole('button', { name: '+ Add model' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat provider' }), {
    target: { value: 'catalog:anthropic' },
  });
  expect(
    screen.queryByRole('option', { name: 'Claude · anthropic' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Anthropic' }));
  expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue('anthropic');
  fireEvent.click(screen.getByRole('button', { name: 'Enter API key' }));
  expect(
    await screen.findByRole('option', { name: 'Claude · anthropic' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Enable screen understanding (optional)'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Screen understanding provider' }), {
    target: { value: 'catalog:openai' },
  });
  const sensing = screen.getByRole('combobox', { name: 'Screen understanding model' });
  expect(sensing.textContent).toContain('Vision model');
  expect(sensing.textContent).not.toContain('Text model');
});

test('keeps saved direct connections editable without requiring sign-in', async () => {
  setup({
    sensing: null,
    tutors: [
      {
        id: 'saved',
        label: 'Saved model',
        provider: 'openai',
        model: 'gpt-saved',
      },
    ],
    defaultTutorId: 'saved',
  });
  render(<LocalModelSettings />);
  expect(await screen.findByLabelText('Chat model ID')).toHaveValue(
    'gpt-saved',
  );
  expect(screen.getByRole('combobox', { name: 'Chat provider' })).toHaveValue(
    'openai',
  );
  expect(screen.getByPlaceholderText('API key')).toBeInTheDocument();
});

test('converts a legacy signed-in selection into the shared model configuration during setup', async () => {
  window.history.pushState({}, '', '/?view=onboarding&modelsOnly=1');
  const { invoke, status } = setup();
  Object.assign(status.connection, {
    mode: 'native',
    provider: 'openai',
    model: 'vision/model',
  });
  const close = jest.spyOn(window, 'close').mockImplementation(() => {});
  try {
    await act(async () => {
      render(<OnboardingView />);
    });
    expect(screen.getByLabelText('Model display name')).toHaveValue(
      'vision/model',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save & start Coco' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'save-model-configuration',
        expect.objectContaining({
          tutors: [
            expect.objectContaining({
              provider: 'pi',
              model: 'pi/openai/vision/model',
            }),
          ],
        }),
      ),
    );
  } finally {
    close.mockRestore();
  }
});
