import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ChatMetrics from './ChatMetrics';

test('shows restored usage across both metric formats without learning prerequisites', () => {
  render(
    <ChatMetrics
      tutorMetrics={{
        prompt_tokens: 1200,
        completion_tokens: 300,
        duration_ms: 2000,
      }}
      observerMetrics={{
        input_tokens: 200,
        output_tokens: 50,
        duration_ms: 500,
      }}
    />,
  );
  expect(
    screen.getByText('Input 1.4k / Output 350 / 2.5s'),
  ).toBeInTheDocument();
});

test('missing usage is unavailable, while an actual zero is preserved', () => {
  render(<ChatMetrics tutorMetrics={{ output_tokens: 0 }} />);
  expect(screen.getByText(/Input Unavailable \/ Output 0/)).toBeInTheDocument();
});

test('scripted messages without model calls have no usage label', () => {
  const { container } = render(<ChatMetrics />);
  expect(container).toBeEmptyDOMElement();
});
