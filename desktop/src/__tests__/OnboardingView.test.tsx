import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import OnboardingView from '../renderer/components/OnboardingView';
import VoiceStep from '../renderer/components/onboarding/VoiceStep';
import PermissionsStep from '../renderer/components/onboarding/PermissionsStep';

describe('onboarding window', () => {
  it('can be hidden temporarily from model-only setup', () => {
    window.history.pushState({}, '', '/?view=onboarding&modelsOnly=1');
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn(async () => null),
        sendMessage,
      },
    };

    render(<OnboardingView />);

    expect(screen.getByText('Model setup')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close setup for now' }),
    );

    expect(sendMessage).toHaveBeenCalledWith('hide-onboarding');
  });
});

it('allows continuing onboarding without screen permissions', async () => {
  window.history.pushState({}, '', '/?view=onboarding');
  (window as any).electron = {
    ipcRenderer: {
      invoke: jest.fn(async (channel) =>
        channel === 'get-system-permissions'
          ? {
              missing: [
                { target: 'screen-recording' },
                { target: 'accessibility' },
              ],
            }
          : null,
      ),
      sendMessage: jest.fn(),
    },
  };
  const view = render(<OnboardingView />);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.change(document.getElementById('ob-user-name')!, {
    target: { value: 'Alex' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Continue without screen access',
    }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Hey Coco' }),
  ).toBeInTheDocument();
  view.unmount();
});


it('confirms wake phrase detection during voice setup and removes its listener', async () => {
  let detected: () => void = () => {};
  const unsubscribe = jest.fn();
  (window as any).electron = {
    ipcRenderer: {
      invoke: jest.fn(async () => ({ enabled: true })),
      on: jest.fn((channel, callback) => {
        if (channel === 'onboarding-wake-word-detected') detected = callback;
        return unsubscribe;
      }),
    },
  };
  const view = render(<VoiceStep onBusy={jest.fn()} />);
  expect(await screen.findByText('Try it now: say “Hey Coco”.')).toBeVisible();
  act(() => detected());
  expect(screen.getByText(/Coco heard you!/)).toBeVisible();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('clears granted permission indicators when a refresh fails', async () => {
  const onReady = jest.fn();
  (window as any).electron = {
    ipcRenderer: {
      invoke: jest.fn()
        .mockResolvedValueOnce({ missing: [] })
        .mockRejectedValue(new Error('Unavailable')),
    },
  };
  render(<PermissionsStep onReady={onReady} />);
  expect(await screen.findAllByText(/^(Granted|Available) ✓$/)).toHaveLength(2);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.queryByText(/^(Granted|Available) ✓$/)).toBeNull();
  expect(screen.getAllByText('Status unavailable')).toHaveLength(2);
  expect(onReady).toHaveBeenLastCalledWith(false);
});
