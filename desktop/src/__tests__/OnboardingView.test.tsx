import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import OnboardingView from '../renderer/components/OnboardingView';

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
