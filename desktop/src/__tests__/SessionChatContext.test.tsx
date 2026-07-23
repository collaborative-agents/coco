import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SessionChatView from '../renderer/components/SessionChatView';

describe('deferred suggestion context', () => {
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
    expect(tutorPayload.userText).toContain('Observation: the full workflow is failing.');
    expect(tutorPayload.userText).toContain('The user now says:\nWhy would that help?');
    expect(screen.getByText('Why would that help?')).toBeInTheDocument();
    expect(
      screen.queryByText(/Suggestion context attached/),
    ).not.toBeInTheDocument();
  });
});
