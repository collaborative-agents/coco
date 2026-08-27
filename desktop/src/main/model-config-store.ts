import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type ProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'nv_inference'
  | 'tinker'
  | 'tinfoil'
  | 'hosted_vllm'
  | 'lm_studio'
  | 'open_anonymity';

export interface ModelConnection {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
}

export interface TutorModelConnection extends ModelConnection {
  supportsAudio: boolean;
}

export interface ModelConfiguration {
  version: 1;
  sensing: ModelConnection;
  tutors: TutorModelConnection[];
  defaultTutorId: string;
}

export interface ModelConfigurationInput {
  sensing: ModelConnection;
  tutors: TutorModelConnection[];
  defaultTutorId: string;
  credentials?: Record<string, string>;
}

export interface ModelConfigurationView extends ModelConfiguration {
  credentialStatus: Record<string, boolean>;
}

/**
 * Models provided to authenticated study participants by the hosted Router.
 * Keep the Router-facing model IDs intact: the desktop adds only the outer
 * `hosted_vllm/` transport prefix when a connection uses another provider.
 */
export const MANAGED_DEFAULT_MODEL_CONFIGURATION: ModelConfigurationInput = {
  sensing: {
    id: 'sensing',
    label: 'Observer',
    provider: 'hosted_vllm',
    model: 'hosted_vllm/qwen3.5-9b',
  },
  tutors: [
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      provider: 'nv_inference',
      model: 'nv_inference/aws/anthropic/bedrock-claude-sonnet-4-6',
      supportsAudio: false,
    },
    {
      id: 'gpt-5-5',
      label: 'GPT-5.5',
      provider: 'nv_inference',
      model: 'nv_inference/openai/openai/gpt-5.5',
      supportsAudio: false,
    },
    {
      id: 'inkling',
      label: 'Inkling',
      provider: 'tinker',
      model: 'tinker/thinkingmachines/Inkling',
      supportsAudio: true,
    },
  ],
  defaultTutorId: 'claude-sonnet-4-6',
};

type CredentialMap = Record<string, string>;
type Environment = Record<string, string | undefined>;

export const isLlmRouterConfigured = (
  environment: Environment = process.env,
): boolean =>
  Boolean(
    environment.LLM_ROUTER_URL?.trim() &&
      environment.LLM_ROUTER_API_KEY?.trim(),
  );

const routerApiBase = (url: string): string => {
  const normalized = url.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
};

const LEGACY_MANAGED_NV_MODELS = new Set([
  'hosted_vllm/aws/anthropic/bedrock-claude-sonnet-4-6',
  'hosted_vllm/openai/openai/gpt-5.5',
]);

const migrateLegacyNvInferenceConnection = <T extends ModelConnection>(
  connection: T,
): T => {
  let model: string | null = null;
  if (
    connection.provider === 'hosted_vllm' &&
    connection.model.startsWith('hosted_vllm/nv_inference/')
  ) {
    model = connection.model.slice('hosted_vllm/'.length);
  } else if (
    connection.provider === 'hosted_vllm' &&
    (LEGACY_MANAGED_NV_MODELS.has(connection.model) ||
      (connection.baseUrl?.includes('inference-api.nvidia.com') &&
        /^hosted_vllm\/(?:aws|openai)\//.test(connection.model)))
  ) {
    model = `nv_inference/${connection.model.slice('hosted_vllm/'.length)}`;
  }
  if (!model) return connection;
  const migrated = {
    ...connection,
    provider: 'nv_inference',
    model,
  } as T;
  // The Router owns the NVIDIA endpoint. Do not retain the old direct endpoint
  // as part of the participant's managed model configuration.
  delete migrated.baseUrl;
  return migrated;
};

const routeConnectionThroughLlmRouter = <T extends ModelConnection>(
  connection: T,
): T => {
  // LiteLLM consumes the outer hosted_vllm prefix to reach the Router. The
  // Router must still receive a provider-qualified model ID of its own.
  // Older managed configs stored NVIDIA IDs as hosted_vllm/nv_inference/...;
  // remove that obsolete transport prefix before adding the current one.
  const migratedConnection = migrateLegacyNvInferenceConnection(connection);
  return {
    ...migratedConnection,
    provider: 'hosted_vllm',
    model: `hosted_vllm/${migratedConnection.model}`,
  };
};

export function routeModelConfigurationThroughLlmRouter(
  config: ModelConfiguration,
): ModelConfiguration {
  return {
    ...config,
    sensing: routeConnectionThroughLlmRouter(config.sensing),
    tutors: config.tutors.map(routeConnectionThroughLlmRouter),
  };
}

const PROVIDER_KEY_ENV: Partial<Record<ProviderId, string>> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  nv_inference: 'NV_INFERENCE_API_KEY',
  tinker: 'TINKER_API_KEY',
  tinfoil: 'TINFOIL_API_KEY',
  hosted_vllm: 'HOSTED_VLLM_API_KEY',
};

export const PROVIDERS: Record<
  ProviderId,
  { label: string; requiresKey: boolean; privacy: string }
> = {
  gemini: { label: 'Google Gemini', requiresKey: true, privacy: 'cloud' },
  openai: { label: 'OpenAI', requiresKey: true, privacy: 'cloud' },
  anthropic: { label: 'Anthropic', requiresKey: true, privacy: 'cloud' },
  nv_inference: {
    label: 'NVIDIA InferenceHub',
    requiresKey: true,
    privacy: 'cloud',
  },
  tinker: { label: 'Tinker', requiresKey: true, privacy: 'cloud' },
  tinfoil: { label: 'Tinfoil', requiresKey: true, privacy: 'confidential' },
  hosted_vllm: {
    label: 'OpenAI-compatible endpoint',
    requiresKey: false,
    privacy: 'self-hosted',
  },
  lm_studio: {
    label: 'LM Studio',
    requiresKey: false,
    privacy: 'local',
  },
  open_anonymity: {
    label: 'Open Anonymity',
    requiresKey: false,
    privacy: 'unlinkable',
  },
};

const configPath = () =>
  path.join(app.getPath('userData'), 'coco-model-config.json');
const credentialsPath = () =>
  path.join(app.getPath('userData'), 'coco-model-credentials.json');

export const credentialId = (role: 'sensing' | 'tutor', provider: ProviderId) =>
  `${role}:${provider}`;

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

function normalizeConnection(value: unknown): ModelConnection | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ModelConnection>;
  if (
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    typeof item.label !== 'string' ||
    !item.label.trim() ||
    !isProvider(item.provider) ||
    typeof item.model !== 'string' ||
    !item.model.trim()
  ) {
    return null;
  }
  let normalizedModel = item.model.trim();
  const expectedPrefix =
    item.provider === 'open_anonymity' ? 'oa/' : `${item.provider}/`;
  if (
    (item.provider === 'hosted_vllm' || item.provider === 'tinker') &&
    !normalizedModel.startsWith(expectedPrefix)
  ) {
    normalizedModel = `${expectedPrefix}${normalizedModel}`;
  }
  if (!normalizedModel.startsWith(expectedPrefix)) return null;
  return {
    id: item.id.trim(),
    label: item.label.trim(),
    provider: item.provider,
    model: normalizedModel,
    ...(typeof item.baseUrl === 'string' && item.baseUrl.trim()
      ? { baseUrl: item.baseUrl.trim() }
      : {}),
  };
}

function normalizeTutorConnection(
  value: unknown,
  allowMissingAudioCapability = false,
): TutorModelConnection | null {
  const connection = normalizeConnection(value);
  if (!connection || !value || typeof value !== 'object') return null;
  const { supportsAudio } = value as Partial<TutorModelConnection>;
  if (typeof supportsAudio !== 'boolean' && !allowMissingAudioCapability) {
    return null;
  }
  return {
    ...connection,
    // Legacy configurations predate this field. Treat them conservatively as
    // text-only until the user explicitly enables audio support in Settings.
    supportsAudio: supportsAudio === true,
  };
}

export function validateModelConfiguration(
  input: ModelConfigurationInput,
  { allowMissingAudioCapability = false } = {},
): ModelConfiguration {
  const sensing = normalizeConnection(input?.sensing);
  if (
    !allowMissingAudioCapability &&
    Array.isArray(input?.tutors) &&
    input.tutors.some(
      (item) =>
        typeof (item as Partial<TutorModelConnection>).supportsAudio !==
        'boolean',
    )
  ) {
    throw new Error('Specify whether every tutor model supports audio input.');
  }
  const tutors = Array.isArray(input?.tutors)
    ? input.tutors
        .map((item) =>
          normalizeTutorConnection(item, allowMissingAudioCapability),
        )
        .filter((item): item is TutorModelConnection => item !== null)
    : [];
  if (!sensing)
    throw new Error('A sensing provider and vision model are required.');
  if (tutors.length === 0) throw new Error('Add at least one tutor model.');
  if (new Set(tutors.map((item) => item.id)).size !== tutors.length) {
    throw new Error('Tutor model IDs must be unique.');
  }
  if (!tutors.some((item) => item.id === input.defaultTutorId)) {
    throw new Error('Choose a default tutor model.');
  }
  return {
    version: 1,
    sensing,
    tutors,
    defaultTutorId: input.defaultTutorId,
  };
}

function readCredentials(): CredentialMap {
  try {
    return JSON.parse(
      fs.readFileSync(credentialsPath(), 'utf8'),
    ) as CredentialMap;
  } catch {
    return {};
  }
}

function atomicWrite(file: string, data: string | Buffer): void {
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function writeCredentials(credentials: CredentialMap): void {
  atomicWrite(credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`);
}

export function readModelConfiguration(): ModelConfiguration | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as
      | ModelConfiguration
      | undefined;
    if (!parsed) return null;
    const config = validateModelConfiguration(parsed, {
      allowMissingAudioCapability: true,
    });
    return {
      ...config,
      sensing: migrateLegacyNvInferenceConnection(config.sensing),
      tutors: config.tutors.map(migrateLegacyNvInferenceConnection),
    };
  } catch {
    return null;
  }
}

export function getModelConfigurationView(): ModelConfigurationView | null {
  const config = readModelConfiguration();
  if (!config) return null;
  const credentials = readCredentials();
  const ids = new Set<string>([
    credentialId('sensing', config.sensing.provider),
    ...config.tutors.map((item) => credentialId('tutor', item.provider)),
  ]);
  return {
    ...config,
    credentialStatus: Object.fromEntries(
      [...ids].map((id) => [id, Boolean(credentials[id])]),
    ),
  };
}

export function saveModelConfiguration(
  input: ModelConfigurationInput,
): ModelConfigurationView {
  const config = validateModelConfiguration(input);
  const credentials = readCredentials();
  Object.entries(input.credentials ?? {}).forEach(([id, value]) => {
    const trimmed = value.trim();
    if (trimmed) credentials[id] = trimmed;
  });

  const allowedCredentialIds = new Set([
    credentialId('sensing', config.sensing.provider),
    ...config.tutors.map((item) => credentialId('tutor', item.provider)),
  ]);
  Object.keys(credentials).forEach((id) => {
    if (!allowedCredentialIds.has(id)) delete credentials[id];
  });

  const required: Array<['sensing' | 'tutor', ProviderId]> = [
    ['sensing', config.sensing.provider],
    ...config.tutors.map((item): ['tutor', ProviderId] => [
      'tutor',
      item.provider,
    ]),
  ];
  const routerManaged = isLlmRouterConfigured();
  required.forEach(([role, provider]) => {
    const envName = PROVIDER_KEY_ENV[provider];
    if (
      !routerManaged &&
      PROVIDERS[provider].requiresKey &&
      !credentials[credentialId(role, provider)] &&
      !process.env[envName ?? '']
    ) {
      throw new Error(`${PROVIDERS[provider].label} requires an API key.`);
    }
  });

  if (Object.keys(credentials).length > 0 || fs.existsSync(credentialsPath())) {
    writeCredentials(credentials);
  }
  atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  return getModelConfigurationView() as ModelConfigurationView;
}

/** Seed hosted study models without replacing an existing user configuration. */
export function ensureManagedDefaultModelConfiguration(): ModelConfigurationView {
  return (
    getModelConfigurationView() ??
    saveModelConfiguration(MANAGED_DEFAULT_MODEL_CONFIGURATION)
  );
}

function connectionEnv(
  connection: ModelConnection,
  role: 'sensing' | 'tutor',
  credentials: CredentialMap,
  fallbackEnv: Environment,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (
    fallbackEnv.LLM_ROUTER_URL?.trim() &&
    fallbackEnv.LLM_ROUTER_API_KEY?.trim()
  ) {
    return {
      HOSTED_VLLM_API_BASE: routerApiBase(fallbackEnv.LLM_ROUTER_URL),
      HOSTED_VLLM_API_KEY: fallbackEnv.LLM_ROUTER_API_KEY.trim(),
    };
  }
  const keyName = PROVIDER_KEY_ENV[connection.provider];
  const key =
    credentials[credentialId(role, connection.provider)] ||
    (keyName ? fallbackEnv[keyName] : undefined);
  if (keyName && key) env[keyName] = key;
  if (connection.provider === 'hosted_vllm' && connection.baseUrl) {
    env.HOSTED_VLLM_API_BASE = connection.baseUrl;
  }
  if (connection.provider === 'tinker' && fallbackEnv.TINKER_BASE_URL) {
    env.TINKER_BASE_URL = fallbackEnv.TINKER_BASE_URL;
  }
  if (
    connection.provider === 'nv_inference' &&
    fallbackEnv.NV_INFERENCE_BASE_URL
  ) {
    env.NV_INFERENCE_BASE_URL = fallbackEnv.NV_INFERENCE_BASE_URL;
  }
  if (connection.provider === 'lm_studio' && connection.baseUrl) {
    env.LM_STUDIO_HOST = connection.baseUrl;
  }
  return env;
}

export function buildRoleModelEnvironments(
  config: ModelConfiguration,
  credentials: CredentialMap,
  fallbackEnv: Environment = {},
): { sensingEnv: Record<string, string>; tutorEnv: Record<string, string> } {
  return {
    sensingEnv: {
      ...connectionEnv(config.sensing, 'sensing', credentials, fallbackEnv),
      MEMORY_MODEL: config.sensing.model,
    },
    tutorEnv: Object.assign(
      {},
      ...config.tutors.map((item) =>
        connectionEnv(item, 'tutor', credentials, fallbackEnv),
      ),
    ),
  };
}

export function resolveModelRuntime(): {
  config: ModelConfiguration;
  sensingEnv: Record<string, string>;
  tutorEnv: Record<string, string>;
} | null {
  const config = readModelConfiguration();
  if (!config) return null;
  const runtimeConfig = isLlmRouterConfigured()
    ? routeModelConfigurationThroughLlmRouter(config)
    : config;
  const credentials = readCredentials();
  const roleEnvironments = buildRoleModelEnvironments(
    runtimeConfig,
    credentials,
    process.env,
  );
  return {
    config: runtimeConfig,
    ...roleEnvironments,
  };
}

export function prepareModelConnectionTest(
  connectionInput: ModelConnection,
  role: 'sensing' | 'tutor',
  apiKey = '',
): { connection: ModelConnection; env: Record<string, string> } {
  const connection = normalizeConnection(connectionInput);
  if (!connection) {
    throw new Error('Enter a valid provider and model ID first.');
  }
  const credentials = readCredentials();
  if (apiKey.trim()) {
    credentials[credentialId(role, connection.provider)] = apiKey.trim();
  }
  const runtimeConnection = isLlmRouterConfigured()
    ? routeConnectionThroughLlmRouter(connection)
    : connection;
  const env = connectionEnv(runtimeConnection, role, credentials, process.env);
  const keyName = PROVIDER_KEY_ENV[connection.provider];
  if (
    !isLlmRouterConfigured() &&
    PROVIDERS[connection.provider].requiresKey &&
    (!keyName || !env[keyName])
  ) {
    throw new Error(
      `${PROVIDERS[connection.provider].label} requires an API key.`,
    );
  }
  if (
    connection.provider === 'hosted_vllm' &&
    !env.HOSTED_VLLM_API_BASE &&
    !isLlmRouterConfigured()
  ) {
    throw new Error('Enter the OpenAI-compatible endpoint base URL.');
  }
  return { connection: runtimeConnection, env };
}

export function defaultTutor(config: ModelConfiguration): TutorModelConnection {
  return (
    config.tutors.find((item) => item.id === config.defaultTutorId) ??
    config.tutors[0]
  );
}

/**
 * Resolve a tutor connection exactly as it must be sent to the running tutor.
 *
 * Persisted configuration intentionally keeps the user's provider-qualified
 * model IDs. In a managed deployment, resolveModelRuntime adds the outer
 * hosted_vllm transport prefix and Router credentials. Runtime call sites must
 * use this helper rather than readModelConfiguration(), or they can
 * accidentally switch the tutor back to a direct provider route.
 */
export function resolveTutorRuntimeConnection(
  tutorId?: string | null,
  { fallbackToDefault = true } = {},
): TutorModelConnection | null {
  const runtime = resolveModelRuntime();
  if (!runtime) return null;
  const selected = tutorId
    ? runtime.config.tutors.find((item) => item.id === tutorId)
    : undefined;
  return selected ?? (fallbackToDefault ? defaultTutor(runtime.config) : null);
}
