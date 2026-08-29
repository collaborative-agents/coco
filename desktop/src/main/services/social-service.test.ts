import { CocoGatewayClient } from './gateway-client';
import SocialBackgroundPoller from './social-background-poller';
import { SocialService } from './social-service';

describe('SocialService', () => {
  it('routes friend requests and actions through the authenticated gateway', async () => {
    const requestJson = jest.fn().mockResolvedValue({ success: true });
    const service = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await service.requestFriend(' Participant.Two ');
    await service.acceptFriend('participant.one:participant.two');
    await service.declineFriend('participant.one:participant.three');

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/api/social/friend-requests',
      'POST',
      { participant_id: 'Participant.Two' },
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/api/social/friend-requests/participant.one%3Aparticipant.two/accept',
      'POST',
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/api/social/friend-requests/participant.one%3Aparticipant.three/decline',
      'POST',
    );
  });

  it('sends idempotent message IDs and encodes message history paths', async () => {
    const requestJson = jest.fn().mockResolvedValue({ messages: [] });
    const service = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await service.sendMessage('friend/id', 'hello');
    await service.listMessages('friend/id', '2026-08-27T12:00:00+00:00');
    await service.markRead('friend/id');

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/api/social/direct-messages',
      'POST',
      {
        _id: expect.any(String),
        recipient_id: 'friend/id',
        content: 'hello',
      },
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/api/social/direct-messages/friend%2Fid?before=2026-08-27T12%3A00%3A00%2B00%3A00',
      'GET',
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/api/social/direct-messages/friend%2Fid/read',
      'PATCH',
    );
  });

  it('fails locally when the gateway or required text is missing', async () => {
    const disabled = new SocialService(() => null);
    const requestJson = jest.fn();
    const enabled = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await expect(disabled.listFriendships()).rejects.toThrow(
      'study server is not configured',
    );
    await expect(enabled.requestFriend('  ')).rejects.toThrow(
      'Participant ID is required',
    );
    await expect(enabled.sendMessage('participant-2', '   ')).rejects.toThrow(
      'Message cannot be empty',
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('creates, answers, and declines knowledge requests through social APIs', async () => {
    const requestJson = jest.fn().mockResolvedValue({ success: true });
    const service = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await service.requestKnowledge('participant-2', 'What setup works?');
    await service.answerKnowledgeRequest('knowledge:1', 'A reviewed answer.');
    await service.declineKnowledgeRequest('knowledge:2');
    await service.markKnowledgeAnswerRead('knowledge:3');

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/api/social/knowledge-requests',
      'POST',
      {
        _id: expect.any(String),
        owner_id: 'participant-2',
        question: 'What setup works?',
      },
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/api/social/knowledge-requests/knowledge%3A1/answer',
      'PATCH',
      { answer: 'A reviewed answer.' },
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/api/social/knowledge-requests/knowledge%3A2/decline',
      'PATCH',
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      4,
      '/api/social/knowledge-requests/knowledge%3A3/read',
      'PATCH',
    );
  });

  it('routes group membership, chat, settings, reports, and announcements', async () => {
    const requestJson = jest.fn().mockResolvedValue({ success: true });
    const service = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await service.listGroupInbox();
    await service.acceptGroupInvitation('invite/1');
    await service.declineGroupInvitation('invite/2');
    await service.listGroupMembers('group/1');
    await service.listGroupMessages('group/1', 12);
    await service.sendGroupMessage('group/1', 'hello group');
    await service.markGroupRead('group/1', 13);
    await service.setGroupMuted('group/1', true);
    await service.leaveGroup('group/1');
    await service.markAnnouncementRead('announcement/1');
    await service.reportGroup('group/1', 'spam', 'review', 'message/1');

    expect(requestJson).toHaveBeenCalledWith('/api/social/group-inbox', 'GET');
    expect(requestJson).toHaveBeenCalledWith(
      '/api/social/group-invitations/invite%2F1/accept',
      'POST',
    );
    expect(requestJson).toHaveBeenCalledWith(
      '/api/social/groups/group%2F1/messages?before_sequence=12',
      'GET',
    );
    expect(requestJson).toHaveBeenCalledWith(
      '/api/social/groups/group%2F1/messages',
      'POST',
      { _id: expect.any(String), content: 'hello group' },
    );
    expect(requestJson).toHaveBeenCalledWith(
      '/api/social/groups/group%2F1/reports',
      'POST',
      {
        _id: expect.any(String),
        reason: 'spam',
        details: 'review',
        message_id: 'message/1',
      },
    );
  });

  it('routes study-admin group operations through protected API paths', async () => {
    const requestJson = jest.fn().mockResolvedValue({ groups: [] });
    const service = new SocialService(
      () => ({ requestJson }) as unknown as CocoGatewayClient,
    );

    await service.listAdminGroups();
    await service.createAdminGroup('Study group', 'Description', ['p-1']);
    await service.updateAdminGroup('group:1', { status: 'archived' });
    await service.inviteAdminGroup('group:1', ['p-2']);
    await service.revokeGroupInvitation('invite:1');
    await service.sendGroupAnnouncement('group:1', 'Group update');
    await service.sendStudyAnnouncement('Study update', 'Everyone sees this');
    await service.listAdminGroupReports();
    await service.reviewAdminGroupReport('report:1', 'reviewed');

    expect(requestJson).toHaveBeenCalledWith('/api/admin/groups', 'GET');
    expect(requestJson).toHaveBeenCalledWith('/api/admin/groups', 'POST', {
      name: 'Study group',
      description: 'Description',
      participant_ids: ['p-1'],
    });
    expect(requestJson).toHaveBeenCalledWith(
      '/api/admin/group-invitations/invite%3A1/revoke',
      'PATCH',
    );
    expect(requestJson).toHaveBeenCalledWith(
      '/api/admin/announcements',
      'POST',
      {
        _id: expect.any(String),
        title: 'Study update',
        content: 'Everyone sees this',
      },
    );
    expect(requestJson).toHaveBeenCalledWith('/api/admin/group-reports', 'GET');
    expect(requestJson).toHaveBeenCalledWith(
      '/api/admin/group-reports/report%3A1',
      'PATCH',
      { status: 'reviewed' },
    );
  });

  it('publishes background inbox totals from friendship polling', async () => {
    const service = {
      listFriendships: jest.fn().mockResolvedValue({
        friends: [
          { participant_id: 'participant-2', unread_count: 2 },
          { participant_id: 'participant-3', unread_count: 1 },
        ],
        incoming: [{ participant_id: 'participant-4' }],
        outgoing: [],
      }),
      listKnowledgeRequests: jest.fn().mockResolvedValue({
        incoming: [{ status: 'pending' }, { status: 'answered' }],
        outgoing: [
          { status: 'answered', answer_read_at: null },
          { status: 'answered', answer_read_at: '2026-08-27T12:00:00Z' },
        ],
      }),
      listGroupInbox: jest.fn().mockResolvedValue({
        groups: [{ unread_count: 4 }],
        invitations: [{}],
        announcements: [{ read_at: null }],
        unread_group_count: 4,
        invitation_count: 1,
        unread_announcement_count: 1,
        can_administer: false,
      }),
    } as unknown as SocialService;
    const publish = jest.fn();
    const poller = new SocialBackgroundPoller(service, publish);

    const snapshot = await poller.refresh();

    expect(snapshot).toEqual(
      expect.objectContaining({
        unreadCount: 3,
        incomingRequestCount: 1,
        incomingKnowledgeRequestCount: 1,
        unreadKnowledgeAnswerCount: 1,
        unreadGroupCount: 4,
        groupInvitationCount: 1,
        unreadAnnouncementCount: 1,
      }),
    );
    expect(publish).toHaveBeenCalledWith(snapshot);
    expect(poller.latestSnapshot()).toBe(snapshot);
  });

  it('continues polling after start and stops its timer on shutdown', async () => {
    jest.useFakeTimers();
    const service = {
      listFriendships: jest.fn().mockResolvedValue({
        friends: [],
        incoming: [],
        outgoing: [],
      }),
      listKnowledgeRequests: jest.fn().mockResolvedValue({
        incoming: [],
        outgoing: [],
      }),
      listGroupInbox: jest.fn().mockResolvedValue({
        groups: [],
        invitations: [],
        announcements: [],
        unread_group_count: 0,
        invitation_count: 0,
        unread_announcement_count: 0,
        can_administer: false,
      }),
    } as unknown as SocialService;
    const poller = new SocialBackgroundPoller(
      service,
      jest.fn(),
      undefined,
      1_000,
    );

    try {
      poller.start();
      await poller.refresh();
      expect(service.listFriendships).toHaveBeenCalledTimes(1);
      expect(service.listKnowledgeRequests).toHaveBeenCalledTimes(1);
      expect(service.listGroupInbox).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1_000);
      await poller.refresh();
      expect(service.listFriendships).toHaveBeenCalledTimes(2);
      expect(service.listKnowledgeRequests).toHaveBeenCalledTimes(2);
      expect(service.listGroupInbox).toHaveBeenCalledTimes(2);

      poller.stop();
      jest.advanceTimersByTime(1_000);
      expect(service.listFriendships).toHaveBeenCalledTimes(2);
      expect(service.listGroupInbox).toHaveBeenCalledTimes(2);
    } finally {
      poller.stop();
      jest.useRealTimers();
    }
  });
});
