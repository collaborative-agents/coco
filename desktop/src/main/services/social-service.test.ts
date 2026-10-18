import { SocialService } from './social-service';

describe('SocialService', () => {
  it('uses authenticated social endpoints, encoding usernames', async () => {
    const requestJson = jest.fn(async () => ({}));
    const service = new SocialService(() => ({ requestJson }) as never);
    await service.listMessages('friend/id');
    expect(requestJson).toHaveBeenCalledWith('/api/social/direct-messages/friend%2Fid', 'GET');
    await service.sendMessage('bob', 'hello');
    expect(requestJson).toHaveBeenLastCalledWith('/api/social/direct-messages', 'POST', {
      _id: expect.any(String), recipient_id: 'bob', content: 'hello',
    });
  });
  it('rejects empty messages without sending a request', async () => {
    const service = new SocialService(() => null);
    await expect(service.sendMessage('bob', '  ')).rejects.toThrow('empty');
    await expect(service.listFriendships()).rejects.toThrow('not configured');
  });
});
