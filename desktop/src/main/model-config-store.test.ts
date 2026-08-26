import {
  buildRoleModelEnvironments,
  credentialId,
  MANAGED_DEFAULT_MODEL_CONFIGURATION,
  routeModelConfigurationThroughLlmRouter,
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
      supportsAudio: true,
    },
    {
      id: 'deep',
      label: 'Deep tutor',
      provider: 'anthropic' as const,
      model: 'anthropic/claude-sonnet',
      supportsAudio: false,
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

  it('provides the managed study models with Claude as the text-only default', () => {
    const config = validateModelConfiguration(
      MANAGED_DEFAULT_MODEL_CONFIGURATION,
    );

    expect(config.sensing.model).toBe('hosted_vllm/qwen3.5-9b');
    expect(config.defaultTutorId).toBe('claude-sonnet-4-6');
    expect(config.tutors).toEqual([
      expect.objectContaining({
        provider: 'nv_inference',
        model: 'nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6',
        supportsAudio: false,
      }),
      expect.objectContaining({
        provider: 'nv_inference',
        model: 'nv_inference/openai/openai/gpt-5.5',
        supportsAudio: false,
      }),
      expect.objectContaining({
        model: 'tinker/thinkingmachines/Inkling',
        supportsAudio: true,
      }),
    ]);
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

  it('requires an explicit audio capability for every tutor', () => {
    const unspecifiedTutor = {
      id: 'unspecified',
      label: 'Unspecified tutor',
      provider: 'gemini' as const,
      model: 'gemini/gemini-flash',
    };
    expect(() =>
      validateModelConfiguration({
        sensing,
        tutors: [unspecifiedTutor] as any,
        defaultTutorId: unspecifiedTutor.id,
      }),
    ).toThrow('Specify whether every tutor model supports audio input.');

    const migrated = validateModelConfiguration(
      {
        sensing,
        tutors: [unspecifiedTutor] as any,
        defaultTutorId: unspecifiedTutor.id,
      },
      { allowMissingAudioCapability: true },
    );
    expect(migrated.tutors[0].supportsAudio).toBe(false);
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

  it('maps the authenticated Router onto LiteLLM hosted-vLLM variables', () => {
    const config = validateModelConfiguration({
      sensing,
      tutors,
      defaultTutorId: 'fast',
    });
    const routerEnvironment = {
      LLM_ROUTER_URL: 'https://router.example.test/',
      LLM_ROUTER_API_KEY: 'participant-router-key',
    };
    const { sensingEnv, tutorEnv } = buildRoleModelEnvironments(
      config,
      {},
      routerEnvironment,
    );

    expect(sensingEnv).toMatchObject({
      HOSTED_VLLM_API_BASE: 'https://router.example.test/v1',
      HOSTED_VLLM_API_KEY: 'participant-router-key',
    });
    expect(tutorEnv).toMatchObject({
      HOSTED_VLLM_API_BASE: 'https://router.example.test/v1',
      HOSTED_VLLM_API_KEY: 'participant-router-key',
    });
    expect(sensingEnv).not.toHaveProperty('LLM_ROUTER_API_KEY');
    expect(tutorEnv).not.toHaveProperty('LLM_ROUTER_API_KEY');
  });

  it('routes every selected model through the hosted-vLLM LiteLLM provider', () => {
    const config = routeModelConfigurationThroughLlmRouter(
      validateModelConfiguration({
        sensing,
        tutors,
        defaultTutorId: 'fast',
      }),
    );

    expect(config.sensing.model).toBe('hosted_vllm/hosted_vllm/Qwen/VL');
    expect(config.tutors[0]).toMatchObject({
      provider: 'hosted_vllm',
      model: 'hosted_vllm/gemini/gemini-flash',
    });
    expect(config.tutors[1]).toMatchObject({
      provider: 'hosted_vllm',
      model: 'hosted_vllm/anthropic/claude-sonnet',
    });
  });

  it('preserves Router-facing provider IDs behind the desktop transport prefix', () => {
    const config = routeModelConfigurationThroughLlmRouter(
      validateModelConfiguration(MANAGED_DEFAULT_MODEL_CONFIGURATION),
    );

    expect(config.sensing.model).toBe('hosted_vllm/hosted_vllm/qwen3.5-9b');
    expect(config.tutors.map((item) => item.model)).toEqual([
      'hosted_vllm/nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6',
      'hosted_vllm/nv_inference/openai/openai/gpt-5.5',
      'hosted_vllm/tinker/thinkingmachines/Inkling',
    ]);
  });

  it('migrates the obsolete hosted-vLLM wrapper on saved NVIDIA models', () => {
    const config = routeModelConfigurationThroughLlmRouter(
      validateModelConfiguration({
        sensing,
        tutors: [
          {
            id: 'legacy-nv',
            label: 'Legacy NVIDIA model',
            provider: 'hosted_vllm',
            model: 'hosted_vllm/nv_inference/openai/openai/gpt-5.5',
            supportsAudio: false,
          },
        ],
        defaultTutorId: 'legacy-nv',
      }),
    );

    expect(config.tutors[0].model).toBe(
      'hosted_vllm/nv_inference/openai/openai/gpt-5.5',
    );
  });

  it('restores the missing NVIDIA provider segment in legacy managed models', () => {
    const config = routeModelConfigurationThroughLlmRouter(
      validateModelConfiguration({
        sensing,
        tutors: [
          {
            id: 'legacy-claude',
            label: 'Legacy Claude',
            provider: 'hosted_vllm',
            model: 'hosted_vllm/aws/anthropic/bedrock-claude-sonnet-4-6',
            baseUrl: 'https://inference-api.nvidia.com/v1',
            supportsAudio: false,
          },
          {
            id: 'legacy-gpt',
            label: 'Legacy GPT',
            provider: 'hosted_vllm',
            model: 'hosted_vllm/openai/openai/gpt-5.5',
            baseUrl: 'https://inference-api.nvidia.com/v1',
            supportsAudio: false,
          },
        ],
        defaultTutorId: 'legacy-claude',
      }),
    );

    expect(config.tutors).toEqual([
      expect.objectContaining({
        provider: 'hosted_vllm',
        model:
          'hosted_vllm/nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6',
      }),
      expect.objectContaining({
        provider: 'hosted_vllm',
        model: 'hosted_vllm/nv_inference/openai/openai/gpt-5.5',
      }),
    ]);
    expect(config.tutors[0]).not.toHaveProperty('baseUrl');
    expect(config.tutors[1]).not.toHaveProperty('baseUrl');
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

    expect(config.sensing.model).toBe('hosted_vllm/thinkingmachines/inkling');
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
          supportsAudio: true,
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
