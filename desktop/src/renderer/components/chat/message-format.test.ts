import { copyableMessageText, parseGuidance } from './message-format';

const guidance =
  'You found the right papers — do a **discernment check**.\nWhich paper applies to your course?';
const raw = `<guidance> ${guidance} </guidance> <four_d_dimension>discernment</four_d_dimension> <teaching_depth>introduce</teaching_depth>`;

test('shows and copies the coaching message without XML metadata', () => {
  expect(parseGuidance(raw).text).toBe(guidance);
  expect(copyableMessageText({ role: 'tutor', text: raw })).toBe(guidance);
  expect(copyableMessageText({ role: 'user', text: raw })).toBe(raw);
});

test('does not flash envelope tags or metadata at any streaming boundary', () => {
  for (let i = 1; i <= raw.length; i += 1) {
    const text = parseGuidance(raw.slice(0, i)).text;
    expect(text).not.toMatch(/[<>]|four_d_dimension|teaching_depth/);
    expect(guidance.startsWith(text)).toBe(true);
  }
});

test('recovers guidance when the closing tag is missing before metadata', () => {
  expect(
    parseGuidance(
      `<guidance>${guidance}<four_d_dimension>discernment</four_d_dimension>`,
    ).text,
  ).toBe(guidance);
});

test('retains example prompts and visualization code in their dedicated fields', () => {
  expect(
    parseGuidance(
      '<guidance>Try this.</guidance><example_prompt>Compare these papers.</example_prompt><html_code><div>Chart</div></html_code>',
    ),
  ).toEqual({
    text: 'Try this.',
    examplePrompt: 'Compare these papers.',
    vizCode: '<div>Chart</div>',
  });
});

test('preserves Markdown, code examples, and legacy JSON responses', () => {
  for (const text of [
    'Use **bold** and `code`.',
    'Example: <guidance>text</guidance>',
    '```xml\n<guidance>Example</guidance>\n```',
  ]) {
    expect(parseGuidance(text).text).toBe(text);
  }
  expect(
    parseGuidance(
      JSON.stringify({ guidance: 'Hello', example_prompt: 'not applicable' }),
    ).text,
  ).toBe('Hello');
  expect(parseGuidance(JSON.stringify({ guidance: raw })).text).toBe(guidance);
});

test('normalizes known competency labels and hides unknown metadata', () => {
  expect(parseGuidance(raw).competency).toBe('discernment');
  expect(
    parseGuidance(
      JSON.stringify({ guidance: 'Hello', four_d_dimension: 'Description' }),
    ).competency,
  ).toBe('description');
  expect(
    parseGuidance(
      '<guidance>Hello</guidance><four_d_dimension>none</four_d_dimension>',
    ).competency,
  ).toBeUndefined();
  expect(
    parseGuidance(
      '<guidance>Hello</guidance><four_d_dimension>unexpected</four_d_dimension>',
    ).competency,
  ).toBeUndefined();
});

test('preserves a full Markdown answer before appended coaching, including while streaming', () => {
  const answer =
    '## Relevant papers\n\n**Paper one** supports your argument.\n\nWould you like a slide summary?';
  const mixed = `${answer}\n\n${raw}`;
  expect(parseGuidance(mixed).text).toBe(`${answer}\n\n${guidance}`);
  expect(parseGuidance(mixed).competency).toBe('discernment');
  expect(copyableMessageText({ role: 'tutor', text: mixed })).toBe(
    `${answer}\n\n${guidance}`,
  );
  for (let i = answer.length + 3; i <= mixed.length; i += 1) {
    const parsed = parseGuidance(mixed.slice(0, i)).text;
    expect(parsed).toContain(answer);
    expect(parsed).not.toMatch(/<\/?guidance|four_d_dimension|teaching_depth/);
  }
});

test('ignores XML examples in code fences before the actual coaching block', () => {
  for (const fence of ['```', '~~~~']) {
    const code = `Example:\n${fence}xml\n<guidance>Keep this literal.</guidance>\n${fence}`;
    expect(parseGuidance(`${code}\n\n${raw}`).text).toBe(
      `${code}\n\n${guidance}`,
    );
    expect(parseGuidance(code).text).toBe(code);
  }
});

test('separates coaching from the main answer but keeps both in copied text', () => {
  const mixed = `Research summary.\n\n${raw}`;
  expect(parseGuidance(mixed)).toMatchObject({
    mainText: 'Research summary.',
    coaching: guidance,
    competency: 'discernment',
  });
  expect(copyableMessageText({ role: 'tutor', text: mixed })).toBe(
    `Research summary.\n\n${guidance}`,
  );
  expect(parseGuidance(JSON.stringify({ guidance: mixed }))).toMatchObject({
    mainText: 'Research summary.',
    coaching: guidance,
  });
  expect(
    parseGuidance(
      JSON.stringify({ guidance, four_d_dimension: 'discernment' }),
    ),
  ).toMatchObject({ mainText: '', coaching: guidance });
});
