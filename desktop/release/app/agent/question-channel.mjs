export const ANSWER_CHANNEL = 'coco:question:answer';
export const CANCEL_CHANNEL = 'coco:question:cancel';

export function waitForAnswer(events, id, questions, signal, ready) {
  return new Promise((resolve) => {
    const finish = (value) => {
      removeAnswer();
      removeCancel();
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => finish({ answers: [], cancelled: true });
    const removeCancel = events.on(CANCEL_CHANNEL, cancel);
    const removeAnswer = events.on(ANSWER_CHANNEL, (request) => {
      if (request.toolCallId !== id) return;
      try {
        const result = normalizeAnswer(questions, request.response);
        request.accepted = true;
        finish(result);
      } catch (error) {
        request.error = error.message;
      }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else ready();
  });
}

export function normalizeAnswer(questions, response) {
  if (response?.cancelled === true) return { answers: [], cancelled: true };
  if (
    !Array.isArray(response?.answers) ||
    response.answers.length !== questions.length
  )
    throw new Error('Answer each question before submitting.');
  const answers = questions.map((question, index) => {
    const input = response.answers[index];
    if (
      !input ||
      !Array.isArray(input.selected) ||
      typeof input.text !== 'string'
    )
      throw new Error('Invalid answer.');
    const selected = [...new Set(input.selected)];
    const text = input.text.trim();
    if (
      text.length > 20000 ||
      selected.some((label) => !question.options.some((o) => o.label === label))
    )
      throw new Error('Invalid answer choice.');
    if (!question.multiSelect && selected.length + Number(Boolean(text)) !== 1)
      throw new Error('Choose one option or write an answer.');
    if (!selected.length && !text)
      throw new Error('Answer each question before submitting.');
    return {
      questionIndex: index,
      question: question.question,
      kind: question.multiSelect ? 'multi' : text ? 'custom' : 'option',
      answer: text || (question.multiSelect ? null : selected[0]),
      ...(question.multiSelect ? { selected } : {}),
      ...(!question.multiSelect &&
      !text &&
      question.options.find((o) => o.label === selected[0])?.preview
        ? {
            preview: question.options.find((o) => o.label === selected[0])
              .preview,
          }
        : {}),
    };
  });
  return { answers, cancelled: false };
}
