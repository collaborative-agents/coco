import { CocoGatewayClient } from './gateway-client';

const jsonResponse = (body: object, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('CocoGatewayClient', () => {
  it('issues a participant Router credential with the signed-in session', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          participant_id: 'p-1',
          token: 'gateway-token',
          expires_at: '2099-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: 'participant-router-token',
          expires_at: '2099-01-01T00:00:00Z',
        }),
      );
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });

    await client.signIn({
      participantId: 'p-1',
      password: 'password-1',
      keepSignedIn: true,
    });
    const credential = await client.issueRouterCredential();

    expect(credential.token).toBe('participant-router-token');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://study.example/api/auth/router-credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer gateway-token',
        }),
      }),
    );
  });

  it('authenticates and sends the bearer token on telemetry writes', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          participant_id: 'p-1',
          token: 'gateway-token',
          expires_at: '2099-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example/',
      fetchImpl,
    });

    await client.signIn({
      participantId: 'p-1',
      password: 'password-1',
      keepSignedIn: true,
    });
    await client.deliver({
      id: 'operation-1',
      type: 'message',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { _id: 'message-1' },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://study.example/api/storage/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer gateway-token',
        }),
      }),
    );
  });

  it('uses the session id in the session-end URL', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });
    client.setAuthSession('token');

    await client.deliver({
      id: 'operation-1',
      type: 'session_end',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { session_id: 'session/a', ended_at: '2026-01-01T01:00:00Z' },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://study.example/api/storage/sessions/session%2Fa/end',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
