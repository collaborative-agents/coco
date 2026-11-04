import { preferenceOutline } from '../renderer/components/preference-outline';

it('separates nested examples from compact previews and preserves full wording', () => {
  const text =
    '## Coco learned preferences\n\n### When to support\n- Offer help during active writing. Keep the full wording here.\n  - Supporting examples:\n    - Editing a report.\n    - Revising a draft.\n- Stay focused on the current task.\n\n### When to stay silent\n- During routine browsing.';
  const sections = preferenceOutline(text);
  expect(sections).toHaveLength(2);
  expect(sections[0].title).toBe('When to support');
  expect(sections[0].items).toHaveLength(2);
  expect(sections[0].items[0].preview).toBe(
    'Offer help during active writing.',
  );
  expect(sections[0].items[0].examples).toBe(2);
  expect(sections[0].items[0].markdown).toContain(
    'Keep the full wording here.',
  );
  expect(sections[0].items[0].markdown).toContain('Revising a draft.');
});

it('keeps long text available without turning it into an oversized preview', () => {
  const text = 'A preference without punctuation '.repeat(20);
  const item = preferenceOutline(`## General\n- ${text}`)[0].items[0];
  expect(item.preview.length).toBeLessThanOrEqual(160);
  expect(item.markdown).toBe(text.trim());
});

it('tracks exact source ranges including nested examples and CRLF', () => {
  const source =
    '## Support\r\n- First.\r\n  - Example.\r\n\r\n- Second.\r\n## Silence\r\n- Third.';
  const item = preferenceOutline(source)[0].items[0];
  expect(source.slice(item.start, item.end)).toBe(
    '- First.\r\n  - Example.\r\n\r\n',
  );
  expect(source.slice(0, item.start) + source.slice(item.end)).toBe(
    '## Support\r\n- Second.\r\n## Silence\r\n- Third.',
  );
});
