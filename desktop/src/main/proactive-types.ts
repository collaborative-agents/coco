import type { ChatSuggestion } from '../shared/chat-suggestion';
import type {
  AiToolButton,
  LLMCallMetrics,
  SupportDimension,
} from '../renderer/components/observation-types';

export interface ChatSeed {
  phrase: string;
  label: string;
  rawObservation: string;
  /** Attach context to the user's next turn instead of sending immediately. */
  deferUntilUserMessage?: boolean;
  /** Pre-fill Coco's composer without sending the message. */
  initialInput?: string;
  draft?: string;
  screenObservation?: string;
  suggestion?: ChatSuggestion;
}

export interface InstantSuggestion {
  kind: 'content' | 'delegate';
  title: string;
  body?: string;
  targetTool?: string;
  prompt?: string;
  copyText: string;
  dimensions?: SupportDimension[];
  availableTools?: AiToolButton[];
  llm_metrics?: LLMCallMetrics;
}
