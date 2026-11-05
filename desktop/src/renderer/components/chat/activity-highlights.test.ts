import activityHighlights from './activity-highlights';

function transform(text: string) {
  const tree = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: text }] },
    ],
  };
  activityHighlights()(tree);
  return tree.children[0].children as any[];
}

it('marks concrete details sparingly and preserves every character', () => {
  const text =
    'Reviewing the implementation in GitHub with router.ts; latency dropped to 12 ms. Then checking Figma.';
  const nodes = transform(text);
  const markers = nodes.filter((node) => node.data?.hName === 'mark');
  expect(markers).toHaveLength(3);
  expect(
    nodes.map((node) => node.value ?? node.children[0].value).join(''),
  ).toBe(text);
  expect(markers.map((node) => node.children[0].value)).toContain('router.ts');
});

it('does not highlight the same term repeatedly or invent highlights for generic prose', () => {
  expect(
    transform('GitHub and GitHub').filter((node) => node.data),
  ).toHaveLength(1);
  expect(
    transform('You have been working for a while.').some((node) => node.data),
  ).toBe(false);
});

it('leaves links, code, and existing emphasis intact', () => {
  const tree = {
    type: 'root',
    children: ['link', 'inlineCode', 'strong', 'emphasis'].map((type) => ({
      type,
      children: [{ type: 'text', value: 'GitHub router.ts' }],
    })),
  };
  const original = JSON.stringify(tree);
  activityHighlights()(tree);
  expect(JSON.stringify(tree)).toBe(original);
});

it('uses a distinct marker for explicit personal matters alongside technical details', () => {
  const text = 'Planning a family dinner after reviewing router.ts in GitHub.';
  const nodes = transform(text);
  const marks = nodes.filter((node) => node.data);
  expect(marks).toHaveLength(3);
  expect(
    marks.find((node) => node.children[0].value === 'family dinner').data
      .hProperties.className,
  ).toContain('activity-marker-personal');
  expect(
    marks.find((node) => node.children[0].value === 'router.ts').data
      .hProperties.className,
  ).not.toContain('activity-marker-personal');
  expect(
    nodes.map((node) => node.value ?? node.children[0].value).join(''),
  ).toBe(text);
});

it('does not classify technical health, model families, or business partners as personal', () => {
  const nodes = transform(
    'Reviewing service health and the model family with a business partner.',
  );
  expect(
    nodes.some((node) =>
      node.data?.hProperties.className.includes('activity-marker-personal'),
    ),
  ).toBe(false);
});
