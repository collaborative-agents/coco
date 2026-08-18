import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuthView from '../renderer/components/AuthView';

describe('participant authentication', () => {
  it('shows validation warnings in English', () => {
    (window as any).electron = {
      ipcRenderer: { invoke: jest.fn(), sendMessage: jest.fn() },
    };

    render(<AuthView />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter your Participant ID.',
    );
  });

  it('keeps users signed in by default and submits signup credentials', async () => {
    const invoke = jest.fn(async () => ({ success: true }));
    const sendMessage = jest.fn();
    (window as any).electron = { ipcRenderer: { invoke, sendMessage } };

    render(<AuthView />);

    expect(screen.getByLabelText(/Keep me signed in/)).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: 'Sign up' }));
    fireEvent.change(screen.getByLabelText('Participant ID'), {
      target: { value: 'participant-001' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('auth-signup', {
        participantId: 'participant-001',
        password: 'password-123',
        keepSignedIn: true,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('authentication-ui-complete');
  });
});
