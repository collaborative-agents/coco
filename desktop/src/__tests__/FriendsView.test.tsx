import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FriendsView from '../renderer/components/FriendsView';

describe('Human chat', () => {
  let invoke: jest.Mock;
  beforeEach(() => {
    invoke = jest.fn(async (channel) => {
      if (channel === 'social-list-friendships')
        return {
          friends: [
            {
              participant_id: 'bob',
              friendship_id: 'alice:bob',
              unread_count: 1,
            },
          ],
          incoming: [],
          outgoing: [],
        };
      if (channel === 'social-list-messages')
        return {
          messages: [
            {
              _id: 'msg',
              sender_id: 'bob',
              content: 'Hi Alice',
              created_at: '2026-09-09T00:00:00Z',
            },
          ],
        };
      return {};
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { ipcRenderer: { invoke } },
    });
  });

  it('sends to the selected friend, never to the tutor', async () => {
    render(<FriendsView onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /bob/ }));
    expect(await screen.findByText('Hi Alice')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message bob'), {
      target: { value: 'Hello Bob' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-send-message',
        'bob',
        'Hello Bob',
      ),
    );
    expect(
      invoke.mock.calls.every(([channel]) => channel.startsWith('social-')),
    ).toBe(true);
  });

  it('shows a backend failure rather than silently claiming success', async () => {
    invoke.mockRejectedValue(new Error('HTTP 404'));
    render(<FriendsView onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 404');
  });

  it('requests a friend using their exact username', async () => {
    render(<FriendsView onClose={() => {}} />);
    await screen.findByRole('button', { name: /bob/ });
    fireEvent.change(screen.getByLabelText('Friend username'), {
      target: { value: 'charlie' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('social-request-friend', 'charlie'),
    );
  });

  it('uses the upstream cards and composer, with no unsupported controls', async () => {
    render(<FriendsView onClose={() => {}} />);
    const friend = await screen.findByRole('button', { name: /bob/ });
    expect(friend.style.borderRadius).toBe('var(--coco-radius-control)');
    fireEvent.click(friend);
    await screen.findByText('Hi Alice');
    expect(screen.queryByText('Ask their Coco')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send a Coco GIF')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Add emoji to message' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert 👍' }));
    expect(screen.getByLabelText('Message bob')).toHaveValue('👍');
    fireEvent.click(screen.getByRole('button', { name: 'Back to friends' }));
    expect(await screen.findByLabelText('Friend username')).toBeInTheDocument();
  });
});
