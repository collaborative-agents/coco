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
