import KnowledgeAnswerService from './knowledge-answer-service';

describe('KnowledgeAnswerService', () => {
  it('syncs local user memory and requests a stateless tutor draft', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: { status: 'ok' } })
      .mockResolvedValueOnce({
        data: { guidance: 'Use a compact VS Code setup.' },
      });
    const service = new KnowledgeAnswerService(
      () => 'Prefers VS Code with few extensions.',
      { post },
      () => 'http://tutor.test/',
    );

    const result = await service.draft(' What editor setup works? ');

    expect(post).toHaveBeenNthCalledWith(
      1,
      'http://tutor.test/context/memory',
      { memory: 'Prefers VS Code with few extensions.' },
      { timeout: 8_000 },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      'http://tutor.test/review/knowledge-answer',
      { question: 'What editor setup works?' },
      { timeout: 60_000 },
    );
    expect(result).toEqual({ answer: 'Use a compact VS Code setup.' });
  });

  it('does not expose memory and rejects blank questions or answers', async () => {
    const service = new KnowledgeAnswerService(() => 'private memory', {
      post: jest
        .fn()
        .mockResolvedValueOnce({ data: { status: 'ok' } })
        .mockResolvedValueOnce({ data: { guidance: '   ' } }),
    });

    await expect(service.draft('   ')).rejects.toThrow('Question is required');
    await expect(service.draft('A real question')).rejects.toThrow(
      'empty answer',
    );
  });
});
