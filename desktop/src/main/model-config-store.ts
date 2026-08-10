import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type ProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
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

export interface ModelConfiguration {
  version: 1;
  sensing: ModelConnection;
  tutors: ModelConnection[];
  defaultTutorId: string;
}

export interface ModelConfigurationInput {
  sensing: ModelConnection;
  tutors: ModelConnection[];
  defaultTutorId: string;
  credentials?: Record<string, string>;
}

export interface ModelConfigurationView extends ModelConfiguration {
  credentialStatus: Record<string, boolean>;
}

type CredentialMap = Record<string, string>;

const PROVIDER_KEY_ENV: Partial<Record<ProviderId, string>> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
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

export const credentialId = (
  role: 'sensing' | 'tutor',
  provider: ProviderId,
) => `${role}:${provider}`;

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
    item.provider === 'hosted_vllm' &&
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

export function validateModelConfiguration(
  input: ModelConfigurationInput,
): ModelConfiguration {
  const sensing = normalizeConnection(input?.sensing);
  const tutors = Array.isArray(input?.tutors)
    ? input.tutors
        .map(normalizeConnection)
        .filter((item): item is ModelConnection => item !== null)
    : [];
  if (!sensing) throw new Error('A sensing provider and vision model are required.');
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
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as CredentialMap;
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
    return parsed ? validateModelConfiguration(parsed) : null;
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
    ...config.tutors.map(
      (item): ['tutor', ProviderId] => ['tutor', item.provider],
    ),
  ];
  required.forEach(([role, provider]) => {
    const envName = PROVIDER_KEY_ENV[provider];
    if (
      PROVIDERS[provider].requiresKey &&
      !credentials[credentialId(role, provider)] &&
      !process.env[envName ?? '']
    ) {
      throw new Error(`${PROVIDERS[provider].label} requires an API key.`);
    }
  });

  if (
    Object.keys(credentials).length > 0 ||
    fs.existsSync(credentialsPath())
  ) {
    writeCredentials(credentials);
  }
  atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  return getModelConfigurationView() as ModelConfigurationView;
}

function connectionEnv(
  connection: ModelConnection,
  role: 'sensing' | 'tutor',
  credentials: CredentialMap,
  fallbackEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  const keyName = PROVIDER_KEY_ENV[connection.provider];
  const key =
    credentials[credentialId(role, connection.provider)] ||
    (keyName ? fallbackEnv[keyName] : undefined);
  if (keyName && key) env[keyName] = key;
  if (connection.provider === 'hosted_vllm' && connection.baseUrl) {
    env.HOSTED_VLLM_API_BASE = connection.baseUrl;
  }
  if (connection.provider === 'lm_studio' && connection.baseUrl) {
    env.LM_STUDIO_HOST = connection.baseUrl;
  }
  return env;
}

export function buildRoleModelEnvironments(
  config: ModelConfiguration,
  credentials: CredentialMap,
  fallbackEnv: NodeJS.ProcessEnv = {},
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
  const credentials = readCredentials();
  const roleEnvironments = buildRoleModelEnvironments(
    config,
    credentials,
    process.env,
  );
  return {
    config,
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
  const env = connectionEnv(connection, role, credentials, process.env);
  const keyName = PROVIDER_KEY_ENV[connection.provider];
  if (PROVIDERS[connection.provider].requiresKey && (!keyName || !env[keyName])) {
    throw new Error(`${PROVIDERS[connection.provider].label} requires an API key.`);
  }
  if (
    connection.provider === 'hosted_vllm' &&
    !env.HOSTED_VLLM_API_BASE
  ) {
    throw new Error('Enter the OpenAI-compatible endpoint base URL.');
  }
  return { connection, env };
}

export function defaultTutor(config: ModelConfiguration): ModelConnection {
  return (
    config.tutors.find((item) => item.id === config.defaultTutorId) ??
    config.tutors[0]
  );
}
