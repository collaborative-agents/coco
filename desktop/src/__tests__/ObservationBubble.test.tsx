import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ObservationBubble from '../renderer/components/ObservationBubble';

describe('ObservationBubble controls', () => {
  it('shows only the dismiss control after a suggestion is revealed', () => {
    render(
      <ObservationBubble
        bubble={{
          status: 'progress',
          phrase: 'Preparing a summary',
          fadingOut: false,
          suggestion: {
            kind: 'content',
            title: 'Research summary',
            body: 'A copy-ready summary.',
            copyText: 'A copy-ready summary.',
          },
        }}
        onDismiss={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Dismiss' }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Why no suggestion?'))
      .not.toBeInTheDocument();
  });

  it('keeps the help badge on a passive bubble without a suggestion', () => {
    render(
      <ObservationBubble
        bubble={{
          status: 'progress',
          phrase: 'Watching for useful moments',
          fadingOut: false,
        }}
      />,
    );

    expect(screen.getByLabelText('Why no suggestion?')).toBeInTheDocument();
  });
});
