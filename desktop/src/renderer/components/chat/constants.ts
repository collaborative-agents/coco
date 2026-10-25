import { AI_TOOLS } from '../observation-types';
import { AGENT_MODES } from '../../../shared/agent-modes';
import type { TutorModelOption } from './types';

export const MODEL_PROVIDER_OPTIONS = [
  ['gemini', 'Google Gemini'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['tinker', 'Tinker'],
  ['tinfoil', 'Tinfoil'],
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio'],
] as const;
export const MODEL_ENDPOINT_PROVIDERS = new Set(['hosted_vllm', 'lm_studio']);

export const blankSensingModel = (): TutorModelOption => ({
  id: 'sensing',
  label: 'Sensing',
  provider: 'gemini',
  model: '',
});

export const blankTutorModel = (): TutorModelOption => ({
  id: 'tutor-1',
  label: 'Primary tutor',
  provider: 'anthropic',
  model: '',
});

// crypto.randomUUID needs a secure context; fall back for safety.
export const CHATBOTS = Object.values(AI_TOOLS).filter(
  (t) => t.category === 'chatbot',
);
export const AGENTS = Object.values(AI_TOOLS).filter(
  (t) => t.category === 'agent',
);
export const MODE_OPTIONS = AGENT_MODES.filter(({ id }) => id !== 'custom');

export const SCREEN_TASK_PROMPT = 'Help me with the current ask on my screen';

export const SECONDARY_CHAT_PROMPTS = [
  'Review my recent work activity to find one part that AI could handle.',
  'Suggest something useful to learn.',
];

export const SUGGESTION_FOLLOW_UPS = [
  'Walk me through this on my screen',
  'Do the first step with me',
  'Why does this help?',
];
