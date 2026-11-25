interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/** Link citations in prose, leaving code and existing Markdown links alone. */
export default function memoryCitations({ numbers }: { numbers: number[] }) {
  const sources = new Set(numbers);
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (
        !node.children ||
        [
          'link',
          'linkReference',
          'code',
          'inlineCode',
          'html',
          'image',
        ].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        const text = child.value;
        const result: MarkdownNode[] = [];
        let offset = 0;
        Array.from(text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)).forEach(
          (match) => {
            const citedNumbers = match[1].split(',').map(Number);
            if (!citedNumbers.every((number) => sources.has(number))) return;
            const start = match.index!;
            if (start > offset)
              result.push({
                type: 'text',
                value: text.slice(offset, start),
              });
            citedNumbers.forEach((number) =>
              result.push({
                type: 'link',
                url: `#screen-source-${number}`,
                children: [{ type: 'text', value: String(number) }],
              }),
            );
            offset = start + match[0].length;
          },
        );
        if (offset < text.length)
          result.push({ type: 'text', value: text.slice(offset) });
        return result;
      });
    };
    visit(tree);
  };
}
