import {
  buildRoleModelEnvironments,
  credentialId,
  resolveModelIds,
  validateModelConfiguration,
} from './model-config-store';

describe('model configuration', () => {
  const sensing = {
    id: 'sensing',
    label: 'Private sensing',
    provider: 'hosted_vllm' as const,
    model: 'hosted_vllm/Qwen/VL',
  };
  const tutors = [
    {
      id: 'fast',
      label: 'Fast tutor',
      provider: 'gemini' as const,
      model: 'gemini/gemini-flash',
    },
    {
      id: 'deep',
      label: 'Deep tutor',
      provider: 'anthropic' as const,
      model: 'anthropic/claude-sonnet',
    },
  ];

  it('requires independent sensing and tutor selections', () => {
    expect(
      validateModelConfiguration({
        sensing,
        tutors,
        defaultTutorId: 'fast',
      }),
    ).toEqual({ version: 1, sensing, tutors, defaultTutorId: 'fast' });
  });

  it('rejects a missing default tutor', () => {
    expect(() =>
      validateModelConfiguration({
        sensing,
        tutors,
        defaultTutorId: 'missing',
      }),
    ).toThrow('Choose a default tutor model.');
  });

  it('uses role-scoped credential IDs', () => {
    expect(credentialId('sensing', 'gemini')).toBe('sensing:gemini');
    expect(credentialId('tutor', 'gemini')).toBe('tutor:gemini');
  });

  it('does not expose sensing credentials to tutors or tutor credentials to sensing', () => {
    const config = validateModelConfiguration({
      sensing: { ...sensing, provider: 'gemini', model: 'gemini/vision' },
      tutors,
      defaultTutorId: 'fast',
    });
    const { sensingEnv, tutorEnv } = buildRoleModelEnvironments(config, {
      'sensing:gemini': 'sensing-secret',
      'tutor:gemini': 'tutor-google-secret',
      'tutor:anthropic': 'tutor-anthropic-secret',
    });

    expect(sensingEnv).toMatchObject({
      GEMINI_API_KEY: 'sensing-secret',
      MEMORY_MODEL: 'gemini/vision',
    });
    expect(sensingEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(tutorEnv).toMatchObject({
      GEMINI_API_KEY: 'tutor-google-secret',
      ANTHROPIC_API_KEY: 'tutor-anthropic-secret',
    });
    expect(tutorEnv.GEMINI_API_KEY).not.toBe(sensingEnv.GEMINI_API_KEY);
  });

  it('supports an optional key for an OpenAI-compatible endpoint', () => {
    const config = validateModelConfiguration({
      sensing: {
        ...sensing,
        baseUrl: 'https://inference.example.test/v1',
      },
      tutors: [tutors[0]],
      defaultTutorId: 'fast',
    });
    const { sensingEnv } = buildRoleModelEnvironments(config, {
      'sensing:hosted_vllm': 'optional-endpoint-key',
    });

    expect(sensingEnv).toMatchObject({
      HOSTED_VLLM_API_BASE: 'https://inference.example.test/v1',
      HOSTED_VLLM_API_KEY: 'optional-endpoint-key',
    });
  });

  it('adds the internal routing prefix to raw endpoint model IDs', () => {
    const config = validateModelConfiguration({
      sensing: {
        ...sensing,
        model: 'thinkingmachines/inkling',
      },
      tutors: [tutors[0]],
      defaultTutorId: 'fast',
    });

    expect(config.sensing?.model).toBe('hosted_vllm/thinkingmachines/inkling');
  });

  it('routes an Inkling tutor through Tinker with a tutor-scoped key', () => {
    const config = validateModelConfiguration({
      sensing,
      tutors: [
        {
          id: 'voice',
          label: 'Voice tutor',
          provider: 'tinker',
          model: 'thinkingmachines/Inkling-Small:peft:262144',
        },
      ],
      defaultTutorId: 'voice',
    });
    const { sensingEnv, tutorEnv } = buildRoleModelEnvironments(config, {
      'tutor:tinker': 'tinker-secret',
    });

    expect(config.tutors[0].model).toBe(
      'tinker/thinkingmachines/Inkling-Small:peft:262144',
    );
    expect(tutorEnv.TINKER_API_KEY).toBe('tinker-secret');
    expect(sensingEnv).not.toHaveProperty('TINKER_API_KEY');
  });
});

describe('shared Pi model assignments', () => {
  const pi = {
    id: 'pi-chat',
    label: 'Connected model',
    provider: 'pi' as const,
    model: 'pi/test/vendor/model',
  };
  const other = { ...pi, id: 'pi-fast', model: 'pi/test/fast' };
  it('routes sensing and suggestions independently without exporting provider credentials', () => {
    const config = validateModelConfiguration({
      sensing: pi,
      tutors: [pi, other],
      defaultTutorId: pi.id,
      instantSuggestionModelId: other.id,
    });
    const env = buildRoleModelEnvironments(config, {});
    expect(env.sensingEnv).toEqual({ MEMORY_MODEL: pi.model });
    expect(env.tutorEnv).toEqual({
      COCO_INSTANT_SUGGESTION_MODEL: other.model,
    });
    const inherited = buildRoleModelEnvironments(
      { ...config, instantSuggestionModelId: undefined },
      {},
    );
    expect(inherited.tutorEnv.COCO_INSTANT_SUGGESTION_MODEL).toBe(pi.model);
  });
  it('rejects a removed suggestion model and incomplete Pi IDs', () => {
    expect(() =>
      validateModelConfiguration({
        sensing: pi,
        tutors: [pi],
        defaultTutorId: pi.id,
        instantSuggestionModelId: 'missing',
      }),
    ).toThrow('instant suggestion');
    expect(() =>
      validateModelConfiguration({
        sensing: { ...pi, model: 'pi/provider' },
        tutors: [pi],
        defaultTutorId: pi.id,
      }),
    ).toThrow('sensing');
  });
});

it('allows chat without sensing and never inherits a legacy observer model', () => {
  const config = validateModelConfiguration({
    sensing: null,
    tutors: [
      { id: 'chat', label: 'Chat', provider: 'pi', model: 'pi/test/chat' },
    ],
    defaultTutorId: 'chat',
  });
  expect(config.sensing).toBeNull();
  expect(resolveModelIds(config, { OBSERVER_MODEL: 'gemini/legacy' })).toEqual({
    tutor: 'pi/test/chat',
    observer: '',
  });
  expect(
    buildRoleModelEnvironments(config, { 'sensing:gemini': 'old-secret' })
      .sensingEnv,
  ).toEqual({});
  expect(
    resolveModelIds(null, {
      TUTOR_MODEL: 'openai/chat',
      OBSERVER_MODEL: 'gemini/legacy',
    }).observer,
  ).toBe('gemini/legacy');
});
