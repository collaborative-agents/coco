import { CocoGatewayClient } from '../main/services/gateway-client';

describe('CocoGatewayClient', () => {
  const originalGatewayUrl = process.env.COCO_GATEWAY_URL;
  const originalGatewayEnabled = process.env.COCO_GATEWAY_ENABLED;

  afterEach(() => {
    if (originalGatewayUrl === undefined) delete process.env.COCO_GATEWAY_URL;
    else process.env.COCO_GATEWAY_URL = originalGatewayUrl;
    if (originalGatewayEnabled === undefined) {
      delete process.env.COCO_GATEWAY_ENABLED;
    } else {
      process.env.COCO_GATEWAY_ENABLED = originalGatewayEnabled;
    }
  });

  it('uses the packaged default URL when no environment URL is set', () => {
    delete process.env.COCO_GATEWAY_URL;
    delete process.env.COCO_GATEWAY_ENABLED;
    const originalFetch = global.fetch;
    global.fetch = jest.fn() as unknown as typeof fetch;

    try {
      expect(
        CocoGatewayClient.fromEnvironment(
          undefined,
          'https://coco.upskilling.saltlab.stanford.edu',
        ),
      ).toBeInstanceOf(CocoGatewayClient);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('allows the packaged default Gateway to be explicitly disabled', () => {
    delete process.env.COCO_GATEWAY_URL;
    process.env.COCO_GATEWAY_ENABLED = '0';

    expect(
      CocoGatewayClient.fromEnvironment(
        undefined,
        'https://coco.upskilling.saltlab.stanford.edu',
      ),
    ).toBeNull();
  });

  it('uses the message schema with the authenticated participant', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      harnessVersionProvider: () => ({}),
    });
    client.setAuthSession('token-1', 'user-1');

    await client.addMessage('session-1', 'user', 'hello');

    const [url, request] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(url).toBe('https://gateway.example/api/storage/messages');
    expect(request.headers.Authorization).toBe('Bearer token-1');
    expect(body).toEqual({
      _id: expect.any(String),
      sid: 'session-1',
      a: { type: 'user', id: 'user-1' },
      content: 'hello',
      ts: expect.any(String),
    });
  });

  it('sends clear session timestamps and recap outcome fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      harnessVersionProvider: () => ({}),
    });
    client.setUserId('user-1');
    client.setAuthSession('token-1', 'user-1');

    await client.startSession(
      'session-1',
      'user_message',
      new Date('2026-08-05T10:00:00.000Z'),
      'Please help me review this spreadsheet.',
    );
    await client.endSession('session-1', {
      endedAt: new Date('2026-08-05T10:15:00.000Z'),
      recapCompletedAt: new Date('2026-08-05T10:15:00.000Z'),
      quizSkipped: false,
      quizAnswered: true,
      quizCorrect: true,
      selectedIndex: 1,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      _id: 'session-1',
      user_id: 'user-1',
      started_at: '2026-08-05T10:00:00.000Z',
      start_trigger: 'user_message',
      start_message: 'Please help me review this spreadsheet.',
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      ended_at: '2026-08-05T10:15:00.000Z',
      recap_completed_at: '2026-08-05T10:15:00.000Z',
      quiz_skipped: false,
      quiz_answered: true,
      quiz_correct: true,
      selected_index: 1,
    });
  });

  it('stores the configured tutor and observer models on each session', async () => {
    const previousTutorModel = process.env.TUTOR_MODEL;
    const previousObserverModel = process.env.OBSERVER_MODEL;
    process.env.TUTOR_MODEL = 'provider/tutor-model';
    process.env.OBSERVER_MODEL = 'provider/observer-model';
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      harnessVersionProvider: () => ({}),
    });
    client.setAuthSession('token-1', 'user-1');

    try {
      await client.startSession(
        'session-1',
        'proactive_suggestion',
        new Date('2026-08-05T10:00:00.000Z'),
        'Use Claude to summarize this document.',
      );
    } finally {
      if (previousTutorModel === undefined) delete process.env.TUTOR_MODEL;
      else process.env.TUTOR_MODEL = previousTutorModel;
      if (previousObserverModel === undefined)
        delete process.env.OBSERVER_MODEL;
      else process.env.OBSERVER_MODEL = previousObserverModel;
    }

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      _id: 'session-1',
      user_id: 'user-1',
      started_at: '2026-08-05T10:00:00.000Z',
      start_trigger: 'proactive_suggestion',
      start_message: 'Use Claude to summarize this document.',
      tutor_model: 'provider/tutor-model',
      observer_model: 'provider/observer-model',
    });
  });

  it('stores timing and model metadata on assistant messages', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.setAuthSession('token-1', 'user-1');

    await client.addMessage('session-1', 'coco', 'response', {
      requestStartedAt: new Date('2026-08-05T10:00:00.000Z'),
      firstTokenAt: new Date('2026-08-05T10:00:00.400Z'),
      responseCompletedAt: new Date('2026-08-05T10:00:01.500Z'),
      model: 'gemini/gemini-3-flash-preview',
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      _id: expect.any(String),
      sid: 'session-1',
      a: { type: 'AITutor', id: 'AITutor' },
      content: 'response',
      ts: '2026-08-05T10:00:01.500Z',
      request_started_at: '2026-08-05T10:00:00.000Z',
      first_token_at: '2026-08-05T10:00:00.400Z',
      response_completed_at: '2026-08-05T10:00:01.500Z',
      model: 'gemini/gemini-3-flash-preview',
    });
  });

  it('stores harness provenance on each session', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      harnessVersionProvider: () => ({
        gitCommitSha: 'abc123',
        gitBranch: 'sensing-growth',
        repository: 'collaborative-agents/monorepo',
        gitDirty: true,
      }),
    });
    client.setAuthSession('token-1', 'user-1');

    await client.startSession(
      'session-1',
      'user_message',
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      _id: 'session-1',
      user_id: 'user-1',
      started_at: '2026-08-05T10:00:00.000Z',
      start_trigger: 'user_message',
      git_commit_sha: 'abc123',
      git_branch: 'sensing-growth',
      repository: 'collaborative-agents/monorepo',
      git_dirty: true,
    });
  });

  it('signs up and restores an authenticated session', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          participant_id: 'participant-1',
          token: 'secret-token',
          expires_at: '2027-02-01T00:00:00Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ participant_id: 'participant-1' }),
      });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await client.signUp({
      participantId: 'participant-1',
      password: 'password-123',
      keepSignedIn: true,
    });
    const restored = await client.restoreAuthSession(session.token);

    expect(session.participantId).toBe('participant-1');
    expect(restored).toEqual({ participantId: 'participant-1' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      participant_id: 'participant-1',
      password: 'password-123',
      keep_signed_in: true,
    });
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('requests a participant Router credential with Gateway authentication', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        token: 'participant-router-token',
        expires_at: '2027-02-01T00:00:00Z',
      }),
    });
    const client = new CocoGatewayClient({
      gatewayUrl: 'https://gateway.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.setAuthSession('gateway-token', 'participant-1');

    const credential = await client.issueRouterCredential();

    expect(credential).toEqual({
      token: 'participant-router-token',
      expiresAt: '2027-02-01T00:00:00Z',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gateway.example/api/auth/router-credential',
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer gateway-token',
    );
  });
});
