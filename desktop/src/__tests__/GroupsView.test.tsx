import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import GroupsView from '../renderer/components/GroupsView';
import type { ElectronHandler } from '../main/preload';

const group = {
  group_id: 'group-1',
  name: 'Calculus study group',
  description: 'Compare problem-solving strategies.',
  status: 'active' as const,
  member_count: 2,
  unread_count: 1,
  last_read_sequence: 0,
  muted: false,
  joined_at: '2026-08-28T12:00:00Z',
  last_message: {
    _id: 'message-1',
    group_id: 'group-1',
    sequence: 1,
    sender_id: 'participant-2',
    sender_label: 'participant-2',
    sender_type: 'participant' as const,
    message_type: 'message' as const,
    content: 'Want to compare answers?',
    created_at: '2026-08-28T12:01:00Z',
  },
};

const ownMessage = {
  ...group.last_message,
  _id: 'message-2',
  sequence: 2,
  sender_id: 'participant-1',
  sender_label: 'participant-1',
  content: 'My earlier answer was 42.',
};

function installElectron(invoke: jest.Mock) {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: { invoke, on: jest.fn(() => jest.fn()) },
    } as unknown as ElectronHandler,
  });
}

describe('GroupsView', () => {
  it('accepts invitations and supports chat, read cursors, members, mute, reports, and leave', async () => {
    let inbox = {
      groups: [] as (typeof group)[],
      invitations: [
        {
          invitation_id: 'invite-1',
          group_id: 'group-1',
          group_name: group.name,
          group_description: group.description,
          member_count: 1,
          status: 'pending',
          created_at: '2026-08-28T12:00:00Z',
        },
      ],
      announcements: [],
      unread_group_count: 0,
      invitation_count: 1,
      unread_announcement_count: 0,
      can_administer: false,
    };
    const invoke = jest.fn((channel: string) => {
      if (channel === 'get-profile') {
        return Promise.resolve({ participantId: 'Participant-1' });
      }
      if (channel === 'social-list-group-inbox') return Promise.resolve(inbox);
      if (channel === 'social-accept-group-invitation') {
        inbox = {
          ...inbox,
          groups: [group],
          invitations: [],
          invitation_count: 0,
        };
      }
      if (channel === 'social-list-group-messages') {
        return Promise.resolve({ messages: [group.last_message, ownMessage] });
      }
      if (channel === 'social-list-group-members') {
        return Promise.resolve({
          members: [
            { participant_id: 'participant-1', joined_at: group.joined_at },
            { participant_id: 'participant-2', joined_at: group.joined_at },
          ],
        });
      }
      if (channel === 'social-leave-group') {
        inbox = { ...inbox, groups: [] };
      }
      return Promise.resolve({ success: true });
    });
    installElectron(invoke);

    render(<GroupsView />);
    expect(await screen.findByText(group.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-accept-group-invitation',
        'invite-1',
      ),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Calculus study group.*Want to compare answers/i,
      }),
    );
    expect(
      await screen.findByText('Want to compare answers?'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('My earlier answer was 42.')).toHaveStyle({
        alignSelf: 'flex-end',
      }),
    );
    expect(screen.getByText('Want to compare answers?')).toHaveStyle({
      alignSelf: 'flex-start',
    });
    expect(
      screen.queryByRole('button', { name: 'Report' }),
    ).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('social-mark-group-read', 'group-1', 2);

    const addReaction = screen.getByRole('button', {
      name: 'React to message message-1',
    });
    expect(addReaction).toHaveStyle({ opacity: '0' });
    fireEvent.mouseEnter(
      screen
        .getByText('Want to compare answers?')
        .closest('[data-message-id="message-1"]')!,
    );
    expect(addReaction).toHaveStyle({ opacity: '1' });
    fireEvent.click(addReaction);
    fireEvent.click(screen.getByRole('button', { name: 'React with 🎉' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-toggle-group-message-reaction',
        'group-1',
        'message-1',
        '🎉',
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Remove 🎉 reaction' }),
    ).toHaveTextContent('🎉 1');

    fireEvent.click(
      screen.getByRole('button', { name: 'Send a Coco GIF to the group' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Send Celebrating Coco' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-send-group-message',
        'group-1',
        'Coco GIF',
        'celebrate',
      ),
    );

    fireEvent.change(screen.getByLabelText(`Message ${group.name}`), {
      target: { value: 'My answer is 42.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add emoji to group message' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert 👍' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-send-group-message',
        'group-1',
        'My answer is 42.👍',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText('participant-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(invoke).toHaveBeenCalledWith(
      'social-set-group-muted',
      'group-1',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report group' }));
    fireEvent.change(screen.getByLabelText('Report details'), {
      target: { value: 'Please review this group.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(invoke).toHaveBeenCalledWith(
      'social-report-group',
      'group-1',
      'other',
      'Please review this group.',
      undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('social-leave-group', 'group-1'),
    );
  });

  it('exposes group and study-wide admin controls only to study admins', async () => {
    const adminGroup = {
      group_id: 'group-1',
      name: group.name,
      description: group.description,
      status: 'active' as const,
      member_count: 1,
      created_at: group.joined_at,
      invitations: [
        {
          invitation_id: 'invite-1',
          participant_id: 'participant-2',
          status: 'pending',
          created_at: group.joined_at,
        },
      ],
    };
    const invoke = jest.fn((channel: string) => {
      if (channel === 'social-list-group-inbox') {
        return Promise.resolve({
          groups: [],
          invitations: [],
          announcements: [],
          unread_group_count: 0,
          invitation_count: 0,
          unread_announcement_count: 0,
          can_administer: true,
        });
      }
      if (channel === 'social-admin-list-groups') {
        return Promise.resolve({ groups: [adminGroup] });
      }
      if (channel === 'social-admin-list-group-reports') {
        return Promise.resolve({
          reports: [
            {
              _id: 'report-1',
              group_id: 'group-1',
              group_name: group.name,
              reporter_id: 'participant-1',
              reason: 'other',
              details: 'Please review this.',
              status: 'open',
              created_at: group.joined_at,
            },
          ],
        });
      }
      return Promise.resolve({ success: true });
    });
    installElectron(invoke);

    render(<GroupsView />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Study admin controls' }),
    );
    expect(
      await screen.findByText('Study group administration'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Please review this.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-review-group-report',
        'report-1',
        'reviewed',
      ),
    );

    fireEvent.change(screen.getByLabelText('New group name'), {
      target: { value: 'Physics study group' },
    });
    fireEvent.change(screen.getByLabelText('Initial participant IDs'), {
      target: { value: 'participant-1, participant-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create and invite' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-create-group',
        'Physics study group',
        '',
        ['participant-1', 'participant-2'],
      ),
    );

    fireEvent.change(screen.getByLabelText(`Announcement to ${group.name}`), {
      target: { value: 'Meet at 4 PM.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-send-group-announcement',
        'group-1',
        'Meet at 4 PM.',
      ),
    );

    fireEvent.change(screen.getByLabelText('Study announcement'), {
      target: { value: 'The study ends Friday.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Broadcast to study' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-send-study-announcement',
        'Study update',
        'The study ends Friday.',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-revoke-invitation',
        'invite-1',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'social-admin-update-group',
        'group-1',
        { status: 'archived' },
      ),
    );
  });
});
