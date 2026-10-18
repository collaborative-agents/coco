export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
  children?: ContextCategory[];
  entries?: { breadcrumb: string[]; tokens: number; text: string }[];
}

/** Read-only, on-demand pi-context-view analysis; never persisted in chat. */
export interface AgentContextSnapshot {
  computedAt: Date | string;
  modelLabel?: string;
  estimatedTokens: number;
  reported?: { tokens?: number; contextWindow: number; percent?: number };
  categories: ContextCategory[];
}
