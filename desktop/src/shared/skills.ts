export interface CuratedSkill {
  id: string;
  name: string;
  description: string;
  markdown: string;
  files: { name: string; content: string }[];
}
