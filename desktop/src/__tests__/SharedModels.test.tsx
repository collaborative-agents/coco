import '@testing-library/jest-dom';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import LocalModelSettings from '../renderer/components/chat/LocalModelSettings';

it('selects connected Pi models for sensing and suggestions and saves through the shared configuration', async () => {
  const invoke = jest.fn(async (channel, action) => {
    if (channel === 'pi-provider')
      return {
        connection: { mode: 'coco' },
        flow: null,
        providers: [{ id: 'test', name: 'Test', connected: true }],
        models: [
          {
            provider: 'test',
            id: 'vision',
            name: 'Vision',
            input: ['text', 'image'],
          },
          { provider: 'test', id: 'text', name: 'Text only', input: ['text'] },
        ],
      };
    if (channel === 'get-model-configuration')
      return {
        sensing: {
          id: 'sensing',
          label: 'Sensing',
          provider: 'pi',
          model: 'pi/test/vision',
        },
        tutors: [
          {
            id: 'chat',
            label: 'Chat',
            provider: 'pi',
            model: 'pi/test/vision',
          },
          { id: 'fast', label: 'Fast', provider: 'pi', model: 'pi/test/text' },
        ],
        defaultTutorId: 'chat',
      };
    if (channel === 'save-model-configuration')
      return { success: true, config: action };
    return null;
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  const view = render(<LocalModelSettings />);
  await waitFor(() =>
    expect(screen.getByLabelText('Sensing Pi model')).toHaveValue(
      'pi/test/vision',
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: 'Pi connections' }),
    ).toBeInTheDocument(),
  );
  const sensing = screen.getByLabelText(
    'Sensing Pi model',
  ) as HTMLSelectElement;
  expect(
    [...sensing.options].some((option) => option.value === 'pi/test/text'),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText('Instant suggestion model'), {
    target: { value: 'fast' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await screen.findByText('Saved');
  expect(invoke).toHaveBeenCalledWith(
    'save-model-configuration',
    expect.objectContaining({
      sensing: expect.objectContaining({
        provider: 'pi',
        model: 'pi/test/vision',
      }),
      defaultTutorId: 'chat',
      instantSuggestionModelId: 'fast',
      credentials: {},
    }),
  );
  expect(screen.queryByText('Use native Pi')).not.toBeInTheDocument();
  view.unmount();
});

it.each([false, true])(
  'saves chat without sensing (previously enabled: %s)',
  async (previouslyEnabled) => {
    const connection = {
      id: 'chat',
      label: 'My chat',
      provider: 'pi',
      model: 'pi/test/text',
    };
    const invoke = jest.fn(async (channel) => {
      if (channel === 'get-model-configuration')
        return {
          sensing: previouslyEnabled ? { ...connection, id: 'sensing' } : null,
          tutors: [connection],
          defaultTutorId: 'chat',
        };
      if (channel === 'pi-provider')
        return {
          connection: { mode: 'coco' },
          providers: [],
          models: [],
          flow: null,
        };
      if (channel === 'save-model-configuration') return { success: true };
      return null;
    });
    (window as any).electron = { ipcRenderer: { invoke } };
    const view = render(<LocalModelSettings />);
    await screen.findByDisplayValue('My chat');
    const toggle = screen.getByRole('checkbox', {
      name: 'Enable screen sensing (optional)',
    });
    if (previouslyEnabled) fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(
        /proactive suggestions and self-evolving memory are unavailable/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Sensing Pi model')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save model settings' }),
    );
    await screen.findByText('Saved');
    expect(invoke).toHaveBeenCalledWith(
      'save-model-configuration',
      expect.objectContaining({
        sensing: null,
        tutors: [expect.objectContaining(connection)],
        credentials: {},
      }),
    );
    view.unmount();
  },
);

it('adds Pi and additional models to one chat list with only four additional providers', async () => {
  const invoke = jest.fn(async (channel) => {
    if (channel === 'pi-provider')
      return {
        connection: { mode: 'coco' },
        flow: null,
        providers: [{ id: 'test', name: 'Test', connected: true }],
        models: [
          { provider: 'test', id: 'chat', name: 'Pi chat', input: ['text'] },
        ],
      };
    if (channel === 'save-model-configuration') return { success: true };
    return null;
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  const view = render(<LocalModelSettings />);
  await screen.findByRole('option', { name: 'Pi chat · test' });
  fireEvent.change(screen.getByLabelText('Add a Pi model to chat'), {
    target: { value: 'pi/test/chat' },
  });
  expect(
    within(
      screen.getByRole('region', { name: 'Pi connections' }),
    ).getByDisplayValue('Pi chat'),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: '+ Add model connection' }),
  );
  const additional = within(
    screen.getByRole('region', { name: 'Additional model connections' }),
  );
  const providers = additional.getByLabelText(
    'Additional provider',
  ) as HTMLSelectElement;
  expect([...providers.options].map((option) => option.value)).toEqual([
    'tinker',
    'tinfoil',
    'hosted_vllm',
    'lm_studio',
  ]);
  fireEvent.change(providers, { target: { value: 'lm_studio' } });
  fireEvent.change(additional.getByLabelText('Model display name'), {
    target: { value: 'Local chat' },
  });
  fireEvent.change(additional.getByLabelText('Additional model ID'), {
    target: { value: 'lm_studio/local' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await screen.findByText('Saved');
  const saved = invoke.mock.calls.find(
    ([channel]) => channel === 'save-model-configuration',
  ) as unknown as [string, any];
  expect(saved[1]).toMatchObject({
    sensing: null,
    tutors: [
      { provider: 'pi', model: 'pi/test/chat' },
      { provider: 'lm_studio', model: 'lm_studio/local' },
    ],
  });
  expect(saved[1].defaultTutorId).toBe(saved[1].tutors[0].id);
  // Users can choose an additional connection alone; removing the default updates it.
  fireEvent.click(screen.getByRole('button', { name: 'Remove Pi chat' }));
  expect(
    screen.getByRole('radio', { name: 'Default for new chats' }),
  ).toBeChecked();
  view.unmount();
});

it('keeps an existing direct provider editable without offering it on new connections', async () => {
  const legacy = {
    id: 'legacy',
    label: 'Existing OpenAI',
    provider: 'openai',
    model: 'openai/existing',
  };
  const invoke = jest.fn(async (channel) => {
    if (channel === 'get-model-configuration')
      return { sensing: null, tutors: [legacy], defaultTutorId: 'legacy' };
    if (channel === 'pi-provider')
      return {
        connection: { mode: 'coco' },
        flow: null,
        providers: [],
        models: [],
      };
    if (channel === 'save-model-configuration') return { success: true };
    return null;
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  const view = render(<LocalModelSettings />);
  await screen.findByDisplayValue('Existing OpenAI');
  expect(
    screen.getByRole('option', { name: 'OpenAI (existing connection)' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await screen.findByText('Saved');
  expect(invoke).toHaveBeenCalledWith(
    'save-model-configuration',
    expect.objectContaining({ tutors: [expect.objectContaining(legacy)] }),
  );
  view.unmount();
});
