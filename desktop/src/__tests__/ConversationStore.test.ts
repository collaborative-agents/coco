import {
  applyStoredReply,
  deriveConversationTitle,
  INTERRUPTED_REPLY_TEXT,
  interruptStaleReplies,
  latestConversation,
  mergeConversationMessages,
  restorableMessages,
  StoredChatMessage,
  StoredConversation,
  tutorRestoreMessage,
} from '../main/conversation-store';

const conversationWith = (
  messages: StoredChatMessage[],
  overrides: Partial<StoredConversation> = {},
): StoredConversation => ({
  sessionId: 'session-1',
  problem: 'General help session',
  createdAt: 1,
  updatedAt: 1,
  messages,
  ...overrides,
});

describe('replies settled after the chat window is gone', () => {
  const asked: StoredChatMessage = { role: 'user', text: 'Draft a message' };
  const pending: StoredChatMessage = {
    role: 'tutor',
    text: 'Let me grab what is on your page.',
    requestId: 'req-1',
    isStreaming: true,
    retryText: 'Draft a message',
  };

  it('replaces partial streamed text with the final reply', () => {
    const settled = applyStoredReply([asked, pending], 'req-1', {
      text: 'Here is a draft.',
    });
    expect(settled?.[1]).toMatchObject({
      role: 'tutor',
      text: 'Here is a draft.',
      requestId: 'req-1',
    });
    expect(settled?.[1].isStreaming).toBeUndefined();
    expect(settled?.[1].retryText).toBeUndefined();
    expect(settled?.[1].id).toEqual(expect.any(String));
  });

  it('keeps retry details when the reply failed', () => {
    const settled = applyStoredReply([asked, pending], 'req-1', {
      text: 'The tutor could not generate a response.',
      isError: true,
    });
    expect(settled?.[1]).toMatchObject({
      isError: true,
      retryText: 'Draft a message',
    });
    expect(settled?.[1].isStreaming).toBeUndefined();
  });

  it('leaves a reply the renderer already finished untouched', () => {
    const finished = { ...pending, isStreaming: undefined, text: 'Done.' };
    expect(
      applyStoredReply([asked, finished], 'req-1', { text: 'Other' }),
    ).toBeNull();
  });

  it('appends the reply when only the user turn was saved', () => {
    expect(
      applyStoredReply(
        [asked],
        'req-1',
        { text: 'Here is a draft.' },
        ' Draft a message ',
      ),
    ).toEqual([asked, expect.objectContaining({ text: 'Here is a draft.' })]);
    expect(
      applyStoredReply([asked], 'req-1', { text: 'Here is a draft.' }, 'Other'),
    ).toBeNull();
  });

  it('marks replies with no live stream as interrupted', () => {
    const restored = interruptStaleReplies(
      conversationWith([asked, pending]),
      () => false,
    );
    expect(restored.messages[1]).toMatchObject({
      text: INTERRUPTED_REPLY_TEXT,
      isError: true,
      retryText: 'Draft a message',
    });
    expect(restored.messages[1].isStreaming).toBeUndefined();

    const live = conversationWith([asked, pending]);
    expect(interruptStaleReplies(live, (id) => id === 'req-1')).toBe(live);
  });

  it('restores only finished turns and skips the turn being sent', () => {
    expect(restorableMessages([asked, pending])).toEqual([
      { role: 'user', text: 'Draft a message' },
    ]);
    expect(
      restorableMessages(
        [{ role: 'tutor', text: 'Hi' }, asked],
        'Draft a message',
      ),
    ).toEqual([{ role: 'tutor', text: 'Hi' }]);
  });
});

describe('conversation reopened by default', () => {
  it('picks the most recently updated conversation with messages', () => {
    const message: StoredChatMessage = { role: 'user', text: 'Hi' };
    const older = conversationWith([message], {
      sessionId: 'older',
      updatedAt: 10,
    });
    const latest = conversationWith([message], {
      sessionId: 'latest',
      updatedAt: 20,
    });
    const empty = conversationWith([], { sessionId: 'empty', updatedAt: 40 });

    expect(latestConversation([older, latest, empty])?.sessionId).toBe(
      'latest',
    );
    expect(latestConversation([empty])).toBeNull();
  });

  it('opens a new chat when the latest session has ended', () => {
    const message: StoredChatMessage = { role: 'user', text: 'Hi' };
    const older = conversationWith([message], {
      sessionId: 'older',
      updatedAt: 10,
    });
    const ended = conversationWith([message], {
      sessionId: 'ended',
      updatedAt: 20,
      endedAt: 20,
    });

    expect(latestConversation([older, ended])).toBeNull();
  });
});

describe('tutor restore messages', () => {
  it('restores suggestions under their own role', () => {
    expect(
      tutorRestoreMessage({
        role: 'tutor',
        text: '**Try this**',
        suggestion: { kind: 'content', title: 'Try this', copyText: 'x' },
      }),
    ).toEqual({ role: 'suggestion', text: '**Try this**' });
    expect(tutorRestoreMessage({ role: 'tutor', text: 'Hello' })).toEqual({
      role: 'tutor',
      text: 'Hello',
    });
  });
});

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

test('keeps usage when main settles a reply while the renderer is closed', () => {
  const metrics = {
    prompt_tokens: 1234,
    completion_tokens: 321,
    duration_ms: 2300,
  };
  const settled = applyStoredReply(
    [
      {
        role: 'tutor',
        text: 'Working…',
        requestId: 'usage',
        isStreaming: true,
      },
    ],
    'usage',
    { text: 'Done.', tutorMetrics: metrics },
  );
  expect(settled?.[0].tutorMetrics).toEqual(metrics);
});
