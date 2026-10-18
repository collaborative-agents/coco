import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuestionCard from './QuestionCard';
import type { TutorToolCall } from '../observation-types';

jest.mock('./MessageContent', () => ({
  TutorMessage: ({ text }: { text: string }) => <span>{text}</span>,
}));
const invoke = jest.fn();
const call: TutorToolCall = {
  id: 'q1',
  name: 'ask_user_question',
  status: 'running',
  arguments: {},
  result: {
    waitingForAnswer: true,
    questions: [
      {
        header: 'Style',
        question: 'Which style?',
        options: [
          { label: 'Brief', description: 'Short answer' },
          {
            label: 'Detailed',
            description: 'Long answer',
            preview: 'Example content',
          },
        ],
      },
    ],
  },
};
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
});
test('waits for explicit submission and supports a free-text answer after choices arrive', async () => {
  const { rerender } = render(
    <QuestionCard call={{ ...call, result: undefined }} interactive />,
  );
  rerender(<QuestionCard call={call} interactive />);
  const submit = screen.getByRole('button', {
    name: 'Submit answers',
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /Brief/ }));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'My own style' },
  });
  expect(
    (screen.getByRole('radio', { name: /Brief/ }) as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(submit);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('answer-agent-question', 'q1', {
      answers: [{ selected: [], text: 'My own style' }],
      cancelled: false,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull(),
  );
});
test('historical questions are read-only and show saved answers', () => {
  render(
    <QuestionCard
      call={{
        ...call,
        status: 'completed',
        result: {
          ...call.result,
          answers: [{ questionIndex: 0, answer: 'Brief' }],
        },
      }}
      interactive={false}
    />,
  );
  expect(screen.getByText('Brief')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
test('failed submission keeps the answers available for retry', async () => {
  invoke.mockRejectedValueOnce(new Error('Disconnected'));
  render(<QuestionCard call={call} interactive />);
  fireEvent.click(screen.getByRole('radio', { name: /Brief/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Disconnected'),
  );
  expect(
    (screen.getByRole('radio', { name: /Brief/ }) as HTMLInputElement).checked,
  ).toBe(true);
});

test('hides pending, failed, and malformed questions without showing technical errors', () => {
  const { container, rerender } = render(
    <QuestionCard call={{ ...call, result: undefined }} interactive />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <QuestionCard
      call={{ ...call, status: 'error', result: { error: 'Invalid JSON' } }}
      interactive
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <QuestionCard
      call={{
        ...call,
        status: 'completed',
        result: { ...call.result, error: 'Validation failed' },
      }}
      interactive
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <QuestionCard
      call={{ ...call, result: { questions: [null] as any } }}
      interactive
    />,
  );
  expect(container.textContent).toBe('');
  rerender(<QuestionCard call={call} interactive />);
  expect(screen.getByText('Which style?')).toBeTruthy();
});
