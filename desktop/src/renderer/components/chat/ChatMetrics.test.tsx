import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ChatMetrics from './ChatMetrics';

test('shows restored usage across both metric formats', () => {
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
  expect(screen.getByText('1.4k in / 350 out / 2.5s')).toBeInTheDocument();
});
