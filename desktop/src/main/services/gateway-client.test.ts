import { CocoGatewayClient } from './gateway-client';

const jsonResponse = (body: object, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('CocoGatewayClient', () => {
  it('includes the email required by the shared Gateway on signup', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          participant_id: 'p-1',
          token: 'gateway-token',
          expires_at: '2099-01-01T00:00:00Z',
        },
        201,
      ),
    );
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });

    await client.signUp({
      participantId: 'p-1',
      email: 'person@example.com',
      password: 'password-1',
      keepSignedIn: true,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      participant_id: 'p-1',
      email: 'person@example.com',
      password: 'password-1',
      keep_signed_in: true,
    });
  });

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
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      ended_at: '2026-01-01T01:00:00Z',
      recap_completed_at: '2026-01-01T01:00:00Z',
      quiz_skipped: true,
      quiz_answered: false,
    });
  });

  it('leaves manual starts unclassified for the shared Gateway', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });

    await client.deliver({
      id: 'operation-1',
      type: 'session_start',
      createdAt: '2026-01-01T00:00:00Z',
      payload: {
        _id: 'session-1',
        started_at: '2026-01-01T00:00:00Z',
        start_trigger: 'manual',
      },
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      start_trigger: null,
    });
  });

  it('skips unsupported optional endpoints but preserves core failures', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'Not Found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ detail: 'Service unavailable' }, 503),
      );
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });
    const optional = {
      id: 'optional-1',
      type: 'interaction_batch' as const,
      createdAt: '2026-01-01T00:00:00Z',
      payload: { events: [] },
    };

    await client.deliver(optional);
    await client.deliver(optional);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      client.deliver({
        ...optional,
        type: 'message',
      }),
    ).rejects.toThrow('Service unavailable');
  });

  it('retries optional events when their endpoint has a server error', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'Temporary failure' }, 503))
      .mockResolvedValueOnce(jsonResponse({ success: true }, 201));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });
    const operation = {
      id: 'optional-1',
      type: 'fatal_error' as const,
      createdAt: '2026-01-01T00:00:00Z',
      payload: { _id: 'fatal-1' },
    };

    await expect(client.deliver(operation)).rejects.toThrow(
      'Temporary failure',
    );
    await client.deliver(operation);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('delivers fatal service errors to the dedicated storage endpoint', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });
    client.setAuthSession('token');

    await client.deliver({
      id: 'operation-fatal-1',
      type: 'fatal_error',
      createdAt: '2026-01-01T00:00:00Z',
      payload: {
        _id: 'fatal-1',
        service: 'observer',
        failure_type: 'unexpected_exit',
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://study.example/api/storage/fatal-errors',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('delivers personalization lifecycle events to the dedicated endpoint', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://study.example',
      fetchImpl,
    });
    client.setAuthSession('token');

    await client.deliver({
      id: 'operation-run-1',
      type: 'personalization_run',
      createdAt: '2026-01-01T00:00:00Z',
      payload: {
        _id: 'event-1',
        run_id: 'run-1',
        job: 'evolve',
        state: 'completed',
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://study.example/api/storage/personalization-run-events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });
});

it('revokes the server session and clears the bearer token on logout', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(jsonResponse({ success: true }));
  const client = new CocoGatewayClient({
    gatewayUrl: 'https://study.example',
    fetchImpl,
  });
  client.setAuthSession('token');
  await client.signOut();
  await client.requestJson('/health', 'GET');
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    'https://study.example/api/auth/logout',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }),
  );
  expect(fetchImpl.mock.calls[1][1].headers).not.toHaveProperty(
    'Authorization',
  );
});

it('renders FastAPI validation errors as readable field messages', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(
    jsonResponse(
      {
        detail: [
          {
            loc: ['body', 'started_at'],
            msg: 'String should match pattern',
          },
        ],
      },
      422,
    ),
  );
  const client = new CocoGatewayClient({
    gatewayUrl: 'https://study.example',
    fetchImpl,
  });
  await expect(
    client.requestJson('/api/storage/sessions', 'POST', {}),
  ).rejects.toThrow('started_at: String should match pattern');
});
