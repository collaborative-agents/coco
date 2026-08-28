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

      jest.advanceTimersByTime(1_000);
      await poller.refresh();
      expect(service.listFriendships).toHaveBeenCalledTimes(2);
      expect(service.listKnowledgeRequests).toHaveBeenCalledTimes(2);

      poller.stop();
      jest.advanceTimersByTime(1_000);
      expect(service.listFriendships).toHaveBeenCalledTimes(2);
    } finally {
      poller.stop();
      jest.useRealTimers();
    }
  });
});
