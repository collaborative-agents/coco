export interface BriefSection {
  title: string;
  text: string;
}
export interface TaskBrief {
  title: string;
  sections: BriefSection[];
}

const headings: Record<string, string> = {
  'story context': 'Background',
  'task overview': 'Your mission',
  'what to do': 'Your task',
  'available files': 'Reference files',
  'what you have': 'Reference files',
  submission: 'Deliverables',
  deliverables: 'Deliverables',
  'evaluation criteria': 'Success criteria',
  'evaluation considerations': 'What to consider',
  'acceptance checklist': 'Success checklist',
  'what not to do (non-goals)': 'Keep in mind',
  'what happens next': 'What happens next',
  'task characteristics': 'About this task',
  'end of the sprint': 'End of the sprint',
};

/** Restructure the source, without summarizing away requirements or constraints. */
export default function parseTaskBrief(
  text: string,
  fallbackTitle: string,
): TaskBrief {
  const lines = text.replace(/\f/g, '\n').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return { title: fallbackTitle, sections: [] };
  const title = lines[first].trim().replace(/^Day\s+\d+\s*[—–:-]\s*/i, '');
  const sections: BriefSection[] = [];
  let current: BriefSection = { title: 'Your mission', text: '' };
  const flush = () => {
    if (current.text.trim())
      sections.push({ ...current, text: current.text.trim() });
  };
  lines.slice(first + 1).forEach((line) => {
    const trimmed = line.trim();
    if (/^BrightNest Living\s*[·•].*Day \d+ of 7$/i.test(trimmed)) return;
    const heading = headings[trimmed.toLowerCase().replace(/:$/, '')];
    if (heading) {
      flush();
      current = { title: heading, text: '' };
    } else current.text += `${line}\n`;
  });
  flush();
  return { title, sections };
}

export function briefParagraphs(
  text: string,
): { list: boolean; text: string }[] {
  const blocks: { list: boolean; text: string }[] = [];
  let current: { list: boolean; text: string } | null = null;
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    const bullet = /^[•●▪]\s*|^[-*]\s+|^\d+[.)]\s+/.test(trimmed);
    if (!trimmed) {
      current = null;
      return;
    }
    if (bullet || !current) {
      current = {
        list: bullet,
        text: trimmed.replace(/^[•●▪]\s*|^[-*]\s+|^\d+[.)]\s+/, ''),
      };
      blocks.push(current);
    } else current.text += ` ${trimmed}`;
  });
  return blocks;
}
