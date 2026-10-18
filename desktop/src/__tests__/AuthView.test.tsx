import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuthView from '../renderer/components/AuthView';

describe('participant authentication', () => {
  it('confirms inside the card before asking the main process to quit', () => {
    const invoke = jest.fn();
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: { invoke, sendMessage, on: jest.fn(() => jest.fn()) },
    };

    render(<AuthView />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Coco Learn' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close Coco Learn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quit Coco Learn' }));
    expect(sendMessage).toHaveBeenCalledWith('quit-from-auth');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps system permission controls out of authentication', () => {
    const invoke = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        invoke,
        sendMessage: jest.fn(),
        on: jest.fn(() => jest.fn()),
      },
    };
    render(<AuthView />);
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Quit Coco Learn' }),
    ).toBeNull();
  });
  it('shows validation warnings in English', () => {
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn(),
        sendMessage: jest.fn(),
        on: jest.fn(() => jest.fn()),
      },
    };

    render(<AuthView />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your username.');
  });

  it('requires a valid email address when signing up', () => {
    const invoke = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        invoke,
        sendMessage: jest.fn(),
        on: jest.fn(() => jest.fn()),
      },
    };

    render(<AuthView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sign up' }));
    expect(
      screen.getByText(
        /only use your email to track your bootcamp progress and contact you if you.*selected for a prize/i,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'participant-001' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a valid email address.',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps users signed in by default and submits signup credentials', async () => {
    const invoke = jest.fn(async () => ({ success: true }));
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: { invoke, sendMessage, on: jest.fn(() => jest.fn()) },
    };

    render(<AuthView />);

    expect(screen.getByLabelText(/Keep me signed in/)).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: 'Sign up' }));
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'participant-001' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'participant@example.com' },
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
        email: 'participant@example.com',
        password: 'password-123',
        keepSignedIn: true,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('authentication-ui-complete');
  });
});
