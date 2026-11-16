/** Add a few marker strokes to prose without modifying its text or markdown. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string[] } };
}

const patterns = [
  /\b[\w-]+\.(?:tsx?|jsx?|py|json|md|csv|pdf|sql|ya?ml|ipynb|cpp|rs|go)\b/g,
  /\b(?:VS Code|Visual Studio Code|ChatGPT|Claude|GitHub|GitLab|Figma|Notion|Slack|Excel|PowerPoint|Google Docs|Google Sheets|Jupyter|PyTorch|TensorFlow|Docker|Kubernetes)\b/gi,
  /\b\d+(?:\.\d+)?\s*(?:%|ms\b|seconds?\b|minutes?\b|hours?\b|GB\b|MB\b|tokens?\b)/gi,
  /\b(?:debugging|comparing|reviewing|writing|editing|testing|implementing|analyzing|refining|investigating|修复|检查)(?:\s+(?!(?:and|or|with|while|using|in|on|to|for|by|but)\b)[\w-]+){1,4}/gi,
];
// Match explicit personal context, rather than ambiguous words such as
// “health” (service health), “family” (model family), or “partner” on their own.
const personalPatterns = [
  /\b(?:family (?:dinner|trip|vacation|visit|plans|time)|(?:birthday|anniversary) (?:party|plans|gift|dinner)|(?:doctor[’']?s?|dentist[’']?s?|medical|dental|therapy) appointment|(?:personal|household|family) budget|(?:sleep|workout|exercise|fitness) (?:schedule|routine|goals?|plan)|(?:vacation|holiday|weekend) plans|childcare|school pickup)\b/gi,
  /\b(?:your|my|their|his|her)\s+(?:mother|father|mom|dad|parents|daughter|son|children|kids|spouse|wife|husband|sister|brother|birthday|anniversary|vacation|wedding|hobbies|hobby)\b/gi,
];
const rules = [
  ...personalPatterns.map((pattern) => ({ pattern, personal: true })),
  ...patterns.map((pattern) => ({ pattern, personal: false })),
];
const excluded = new Set([
  'link',
  'linkReference',
  'code',
  'inlineCode',
  'html',
  'strong',
  'emphasis',
  'image',
]);

export default function activityHighlights() {
  return (tree: MarkdownNode) => {
    let remaining = 3;
    const seen = new Set<string>();
    const visit = (node: MarkdownNode) => {
      if (!node.children || excluded.has(node.type) || !remaining) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== 'text' || !child.value || !remaining) {
          visit(child);
          return [child];
        }
        const text = child.value;
        const spans: {
          start: number;
          end: number;
          text: string;
          personal: boolean;
        }[] = [];
        rules.forEach(({ pattern, personal }) => {
          Array.from(text.matchAll(pattern)).forEach((match) => {
            const start = match.index!;
            const end = start + match[0].length;
            const key = match[0].toLowerCase();
            if (
              spans.length >= remaining ||
              seen.has(key) ||
              spans.some((span) => start < span.end && end > span.start)
            )
              return;
            spans.push({ start, end, text: match[0], personal });
            seen.add(key);
          });
        });
        if (!spans.length) return [child];
        remaining -= spans.length;
        const result: MarkdownNode[] = [];
        let offset = 0;
        spans
          .sort((a, b) => a.start - b.start)
          .forEach((span) => {
            if (span.start > offset)
              result.push({
                type: 'text',
                value: text.slice(offset, span.start),
              });
            result.push({
              type: 'emphasis',
              data: {
                hName: 'mark',
                hProperties: {
                  className: span.personal
                    ? ['activity-marker', 'activity-marker-personal']
                    : ['activity-marker'],
                },
              },
              children: [{ type: 'text', value: span.text }],
            });
            offset = span.end;
          });
        if (offset < text.length)
          result.push({ type: 'text', value: text.slice(offset) });
        return result;
      });
    };
    visit(tree);
  };
}
