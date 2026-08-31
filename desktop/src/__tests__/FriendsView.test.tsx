import React from 'react';
import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import FriendsView, { FriendsButton } from '../renderer/components/FriendsView';
import type { ElectronHandler } from '../main/preload';

const friendships = {
  friends: [
    {
      friendship_id: 'participant-1:participant-2',
      participant_id: 'Participant-2',
      status: 'accepted',
      created_at: '2026-08-27T12:00:00Z',
      updated_at: '2026-08-27T12:00:00Z',
      unread_count: 1,
      last_message: {
        _id: 'message-1',
        sender_id: 'participant-2',
        recipient_id: 'participant-1',
        content: 'Want to compare study notes?',
        created_at: '2026-08-27T12:01:00Z',
      },
    },
  ],
  incoming: [
    {
      friendship_id: 'participant-1:participant-3',
      participant_id: 'Participant-3',
      status: 'pending',
      direction: 'incoming',
      created_at: '2026-08-27T12:00:00Z',
      updated_at: '2026-08-27T12:00:00Z',
    },
  ],
  outgoing: [],
};

const knowledgeRequests = {
  incoming: [
    {
      _id: 'knowledge-1',
      requester_id: 'Participant-3',
      owner_id: 'Participant-1',
      question: 'What study routine worked best for you?',
      status: 'pending',
      created_at: '2026-08-27T12:00:00Z',
      updated_at: '2026-08-27T12:00:00Z',
      answer: null as string | null,
    },
  ],
  outgoing: [],
};

const ownerFriendships = {
  friends: [
    {
      friendship_id: 'participant-1:participant-3',
      participant_id: 'Participant-3',
      status: 'accepted',
      created_at: '2026-08-27T12:00:00Z',
      updated_at: '2026-08-27T12:00:00Z',
      unread_count: 0,
      last_message: null,
    },
  ],
  incoming: [],
  outgoing: [],
};

describe('FriendsView', () => {
  it('accepts requests, opens a conversation, and sends messages', async () => {
    const invoke = jest.fn((channel: string) => {
      if (channel === 'social-list-friendships') {
        return Promise.resolve(friendships);
      }
      if (channel === 'social-list-messages') {
        return Promise.resolve({
          messages: [friendships.friends[0].last_message],
        });
      }
      if (channel === 'social-list-knowledge-requests') {
        return Promise.resolve({ incoming: [], outgoing: [] });
      }
      return Promise.resolve({ success: true });
    });
    const on = jest.fn(() => jest.fn());
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: { invoke, on },
      } as unknown as ElectronHandler,
    });

    render(<FriendsView onClose={jest.fn()} />);

    expect(await screen.findByText('Wants to add you')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-accept-friend',
        'participant-1:participant-3',
      ),
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Participant-2.*Want to compare/i }),
    );
    expect(
      await screen.findByText('Want to compare study notes?'),
    ).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('social-mark-read', 'Participant-2');

    fireEvent.change(screen.getByLabelText('Message Participant-2'), {
      target: { value: 'Yes, sounds good.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-send-message',
        'Participant-2',
        'Yes, sounds good.',
      ),
    );
  });

  it('asks a friend for a consent-gated knowledge answer', async () => {
    let currentKnowledgeRequests: {
      incoming: typeof knowledgeRequests.incoming;
      outgoing: typeof knowledgeRequests.incoming;
    } = { incoming: [], outgoing: [] };
    const invoke = jest.fn((channel: string, ...args: string[]) => {
      if (channel === 'social-list-friendships') {
        return Promise.resolve(friendships);
      }
      if (channel === 'social-list-messages') {
        return Promise.resolve({ messages: [] });
      }
      if (channel === 'social-list-knowledge-requests') {
        return Promise.resolve(currentKnowledgeRequests);
      }
      if (channel === 'social-request-knowledge') {
        currentKnowledgeRequests = {
          incoming: [],
          outgoing: [
            {
              ...knowledgeRequests.incoming[0],
              requester_id: 'Participant-1',
              owner_id: args[0],
              question: args[1],
            },
          ],
        };
      }
      return Promise.resolve({ success: true });
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: { invoke, on: jest.fn(() => jest.fn()) },
      } as unknown as ElectronHandler,
    });

    render(<FriendsView onClose={jest.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Participant-2.*Want to compare/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask their Coco' }));
    fireEvent.change(
      screen.getByLabelText("Question for Participant-2's Coco"),
      { target: { value: 'What helped you focus?' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request answer' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-request-knowledge',
        'Participant-2',
        'What helped you focus?',
      ),
    );
    expect(
      await screen.findByText('Question sent to Participant-2 for approval.'),
    ).toBeInTheDocument();
    expect(screen.getByText('✦ Coco memory request')).toBeInTheDocument();
    expect(
      screen
        .getByText('What helped you focus?')
        .closest('[data-message-kind="knowledge-request"]'),
    ).toHaveAttribute('data-message-owner', 'self');
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
  });

  it('generates a local draft and sends the owner-edited answer', async () => {
    let currentKnowledgeRequests = knowledgeRequests;
    const invoke = jest.fn((channel: string, ...args: string[]) => {
      if (channel === 'social-list-friendships') {
        return Promise.resolve(ownerFriendships);
      }
      if (channel === 'social-list-messages') {
        return Promise.resolve({ messages: [] });
      }
      if (channel === 'social-list-knowledge-requests') {
        return Promise.resolve(currentKnowledgeRequests);
      }
      if (channel === 'social-draft-knowledge-answer') {
        return Promise.resolve({ answer: 'Use the tutor draft.' });
      }
      if (channel === 'social-answer-knowledge-request') {
        currentKnowledgeRequests = {
          incoming: [
            {
              ...knowledgeRequests.incoming[0],
              status: 'answered',
              answer: args[1],
            },
          ],
          outgoing: [],
        };
      }
      return Promise.resolve({ success: true });
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: { invoke, on: jest.fn(() => jest.fn()) },
      } as unknown as ElectronHandler,
    });

    render(<FriendsView onClose={jest.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Participant-3.*Coco request/i,
      }),
    );
    expect(screen.getByText('✦ Coco memory request')).toBeInTheDocument();
    expect(
      (
        await screen.findByText('What study routine worked best for you?')
      ).closest('[data-message-kind="knowledge-request"]'),
    ).toHaveAttribute('data-message-owner', 'friend');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & draft' }));
    expect(invoke).toHaveBeenCalledWith(
      'social-draft-knowledge-answer',
      'What study routine worked best for you?',
    );

    const answer = await screen.findByLabelText('Answer to Participant-3');
    fireEvent.change(answer, {
      target: { value: 'I edited this before sharing it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-answer-knowledge-request',
        'knowledge-1',
        'I edited this before sharing it.',
      ),
    );
    expect(await screen.findByText('Answer sent')).toBeInTheDocument();
    expect(
      screen
        .getByText('I edited this before sharing it.')
        .closest('[data-message-kind="knowledge-answer"]'),
    ).toHaveAttribute('data-message-owner', 'self');
    expect(
      screen.queryByLabelText('Answer to Participant-3'),
    ).not.toBeInTheDocument();
  });

  it('shows background unread messages and requests on the Friends button', () => {
    let inboxListener: ((value: unknown) => void) | undefined;
    const on = jest.fn(
      (channel: string, listener: (value: unknown) => void) => {
        if (channel === 'social-inbox-updated') inboxListener = listener;
        return jest.fn();
      },
    );
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: { on },
      } as unknown as ElectronHandler,
    });

    render(
      <FriendsButton
        active={false}
        onClick={jest.fn()}
        style={{}}
        activeStyle={{}}
      />,
    );
    act(() => {
      inboxListener?.({
        friendships,
        knowledgeRequests,
        unreadCount: 2,
        incomingRequestCount: 1,
        incomingKnowledgeRequestCount: 1,
        unreadKnowledgeAnswerCount: 1,
        updatedAt: '2026-08-27T12:00:00Z',
      });
    });

    const socialButton = screen.getByRole('button', {
      name: 'Social and messages (5 new)',
    });
    expect(socialButton).toBeInTheDocument();
    expect(socialButton.querySelector('svg')).toHaveAttribute('width', '12');
    expect(screen.queryByText('♡')).not.toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
