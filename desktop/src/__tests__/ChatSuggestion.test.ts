import {
  chatSuggestionText,
  parseChatSuggestion,
} from '../shared/chat-suggestion';

describe('chat suggestions', () => {
  it('formats delegate suggestions with their prompt', () => {
    expect(
      chatSuggestionText({
        kind: 'delegate',
        title: 'Draft the update with Claude',
        prompt: 'Stage: ...\nTask: ...\nRules: ...',
        copyText: 'Stage: ...',
      }),
    ).toBe(
      '**Draft the update with Claude**\n\nStage: ...\nTask: ...\nRules: ...',
    );
  });

  it('formats content suggestions with their body', () => {
    expect(
      chatSuggestionText({
        kind: 'content',
        title: 'Check the numbers',
        body: 'Verify the totals before sending.',
        copyText: 'Verify the totals before sending.',
      }),
    ).toBe('**Check the numbers**\n\nVerify the totals before sending.');
  });

  it('leads with the explanation when there is one', () => {
    expect(
      chatSuggestionText({
        kind: 'content',
        title: 'Check the dates',
        body: 'Compare each date.',
        copyText: 'Compare each date.',
        noticed: "Looks like you're pasting a summary.",
        check: 'Check the dates.',
      }),
    ).toBe(
      "Looks like you're pasting a summary. Check the dates.\n\n**Check the dates**\n\nCompare each date.",
    );
  });

  it('keeps valid stored suggestions and their tool', () => {
    expect(
      parseChatSuggestion({
        observationId: 'obs-1',
        kind: 'delegate',
        title: 'T',
        prompt: 'P',
        copyText: 'P',
        tool: { id: 'claude', label: 'Claude' },
        extra: 'ignored',
      }),
    ).toEqual({
      observationId: 'obs-1',
      kind: 'delegate',
      title: 'T',
      body: undefined,
      prompt: 'P',
      copyText: 'P',
      tool: { id: 'claude', label: 'Claude' },
    });
  });

  it.each([
    null,
    'text',
    { kind: 'other', title: 'T', copyText: 'C' },
    { kind: 'content' },
  ])('rejects malformed suggestions: %p', (value) => {
    expect(parseChatSuggestion(value)).toBeNull();
  });
});
