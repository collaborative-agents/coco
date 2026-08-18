import {
  buildRoleModelEnvironments,
  credentialId,
  isLlmRouterConfigured,
  normalizeRouterManagedModelConfiguration,
  ROUTER_MANAGED_MODEL_CONFIGURATION,
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

  it('recognizes a fully configured hosted router', () => {
    expect(
      isLlmRouterConfigured({
        LLM_ROUTER_URL: 'https://router.example.test',
        LLM_ROUTER_API_KEY: 'project-key',
      }),
    ).toBe(true);
    expect(
      isLlmRouterConfigured({ LLM_ROUTER_URL: 'https://router.example.test' }),
    ).toBe(false);
  });

  it('uses the pilot models when configuration is managed by the router', () => {
    expect(ROUTER_MANAGED_MODEL_CONFIGURATION.sensing.model).toBe(
      'gemini/gemini-2.5-pro',
    );
    expect(ROUTER_MANAGED_MODEL_CONFIGURATION.tutors[0].model).toBe(
      'gemini/gemini-3-flash-preview',
    );
  });

  it('replaces unsupported Router tutors while preserving Gemini choices', () => {
    const anthropicOnly = validateModelConfiguration({
      sensing,
      tutors: [tutors[1]],
      defaultTutorId: 'deep',
    });
    expect(
      normalizeRouterManagedModelConfiguration(anthropicOnly).tutors,
    ).toEqual(ROUTER_MANAGED_MODEL_CONFIGURATION.tutors);

    const mixed = validateModelConfiguration({
      sensing,
      tutors,
      defaultTutorId: 'fast',
    });
    expect(normalizeRouterManagedModelConfiguration(mixed)).toMatchObject({
      tutors: [tutors[0]],
      defaultTutorId: 'fast',
    });
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

    expect(config.sensing.model).toBe(
      'hosted_vllm/thinkingmachines/inkling',
    );
  });
});
