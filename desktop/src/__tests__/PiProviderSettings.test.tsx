import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PiProviderSettings from '../renderer/components/chat/PiProviderSettings';
import OnboardingView from '../renderer/components/OnboardingView';

function setup(mode = 'coco') {
  const status = {
    connection: { mode, provider: 'test', model: 'model' },
    providers: [
      {
        id: 'test',
        name: 'Test provider',
        oauth: 'Sign in with Test',
        connected: true,
      },
    ],
    models: [{ provider: 'test', id: 'model', name: 'Test model' }],
    flow: null,
  };
  const invoke = jest.fn(async (channel, action, payload) => {
    if (channel !== 'pi-provider') return null;
    if (action === 'save') status.connection = payload;
    return status;
  });
  const sendMessage = jest.fn();
  (window as any).electron = { ipcRenderer: { invoke, sendMessage } };
  return { invoke, sendMessage };
}

test('starts native login, saves a selected native model, and cancels on close', async () => {
  const { invoke } = setup();
  const view = render(<PiProviderSettings />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Sign in with Test' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('pi-provider', 'login', {
      provider: 'test',
      type: 'oauth',
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Use native Pi' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use native Pi' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('pi-provider', 'save', {
      mode: 'native',
      provider: 'test',
      model: 'model',
    }),
  );
  view.unmount();
  expect(invoke).toHaveBeenCalledWith('pi-provider', 'cancel', undefined);
});

test('native-only onboarding finishes without saving a Coco model configuration', async () => {
  window.history.pushState({}, '', '/?view=onboarding&modelsOnly=1');
  const { invoke, sendMessage } = setup('native');
  const close = jest.spyOn(window, 'close').mockImplementation(() => {});
  render(<OnboardingView />);
  await screen.findByRole('button', { name: 'Use native Pi' });
  fireEvent.click(
    screen.getByRole('button', { name: /Save|Finish|Start|Continue/i }),
  );
  await waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith('model-configuration-complete'),
  );
  expect(
    invoke.mock.calls.some((call) => call[0] === 'save-model-configuration'),
  ).toBe(false);
  close.mockRestore();
});
