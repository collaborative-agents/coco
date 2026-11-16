export interface PreferenceItem {
  id: string;
  preview: string;
  markdown: string;
  examples: number;
  start: number;
  end: number;
}
export interface PreferenceSection {
  title: string;
  items: PreferenceItem[];
}

/** Preserve the saved wording; previews are excerpts, never generated summaries. */
export function preferenceOutline(content: string): PreferenceSection[] {
  const sections: PreferenceSection[] = [];
  let section: PreferenceSection = { title: 'Learned preferences', items: [] };
  let lines: string[] = [];
  let start = 0;
  let offset = 0;
  const flush = () => {
    const markdown = lines.join('\n').trim();
    if (!markdown) return;
    const lead = (lines[0] ?? '')
      .replace(/^\s*[-*+]\s+|^\s*\d+\.\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    const firstSentence = lead.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || lead;
    const preview =
      firstSentence.length > 160
        ? `${firstSentence.slice(0, 157).replace(/\s+\S*$/, '')}…`
        : firstSentence;
    section.items.push({
      id: `preference-${sections.length}-${section.items.length}`,
      preview,
      markdown,
      start,
      end: offset,
      examples: lines.filter((line) => /^\s{4,}[-*+]\s+/.test(line)).length,
    });
    lines = [];
  };
  for (const raw of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, '');
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      if (section.items.length) sections.push(section);
      section = { title: heading[1], items: [] };
      start = offset + raw.length;
    } else if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      flush();
      start = offset;
      lines = [line.replace(/^(?:[-*+]|\d+\.)\s+/, '')];
    } else {
      lines.push(line);
    }
    offset += raw.length;
  }
  flush();
  if (section.items.length) sections.push(section);
  return sections;
}
