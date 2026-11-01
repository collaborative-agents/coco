export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  files: { name: string; content: string }[];
}
export interface SkillWorkshopSession {
  sessionId: string;
  draft: SkillDraft | null;
  version: number;
  trials: { input: string; output: string; draftVersion: number }[];
  messages: { id: string; role: 'user' | 'assistant'; text: string }[];
  awaitingSave: boolean;
  savedSkillId: string | null;
}
