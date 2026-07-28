import {
  deriveConversationTitle,
  mergeConversationMessages,
  StoredChatMessage,
} from '../main/conversation-store';

describe('conversation snapshot merging', () => {
  const earlier: StoredChatMessage[] = [
    { role: 'user', text: 'First question' },
    { role: 'tutor', text: 'First answer' },
  ];

  it('appends new turns saved after a renderer reload', () => {
    const continuation: StoredChatMessage[] = [
      { role: 'user', text: 'Question after reload' },
      { role: 'tutor', text: 'Answer after reload' },
    ];

    expect(mergeConversationMessages(earlier, continuation)).toEqual([
      ...earlier,
      ...continuation,
    ]);
  });

  it('does not replace a transcript with a shorter prefix', () => {
    expect(mergeConversationMessages(earlier, earlier.slice(0, 1))).toEqual(
      earlier,
    );
  });

  it('keeps a full snapshot authoritative for retry edits', () => {
    const failed: StoredChatMessage[] = [
      ...earlier,
      { role: 'user', text: 'Try this request' },
      { role: 'tutor', text: 'Request timed out', isError: true },
    ];
    const retried: StoredChatMessage[] = [
      ...earlier,
      { role: 'user', text: 'Try this request' },
      { role: 'tutor', text: 'Successful answer' },
    ];

    expect(mergeConversationMessages(failed, retried)).toEqual(retried);
  });
});

describe('conversation title generation', () => {
  it('uses a meaningful task label when available', () => {
    expect(
      deriveConversationTitle('Review the evaluation plan', [
        { role: 'user', text: 'Can you help?' },
      ]),
    ).toBe('Review the evaluation plan');
  });

  it('names general sessions from the first user message', () => {
    expect(
      deriveConversationTitle('General help session', [
        {
          role: 'user',
          text: '# Discuss limitations in prior literature\n\nMore context follows.',
        },
      ]),
    ).toBe('Discuss limitations in prior literature More context follows.');
  });

  it('caps long titles', () => {
    const title = deriveConversationTitle('', [
      {
        role: 'user',
        text: 'Help me design a comprehensive evaluation framework for continuous on-device personalization and proactive support',
      },
    ]);

    expect(title.length).toBeLessThanOrEqual(73);
    expect(title.endsWith('…')).toBe(true);
  });
});
