import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import ObservationBubble from '../renderer/components/ObservationBubble';

describe('ObservationBubble controls', () => {
  afterEach(() => {
    delete (window as any).electron;
  });

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

  it('allows an accidental suggestion rating to be corrected', () => {
    const sendMessage = jest.fn();
    (window as any).electron = { ipcRenderer: { sendMessage } };
    render(
      <ObservationBubble
        bubble={{
          observationId: 'obs-1',
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
      />,
    );

    const good = screen.getByRole('button', { name: 'Good suggestion' });
    const bad = screen.getByRole('button', { name: 'Not helpful' });
    fireEvent.click(good);
    expect(good).toBeDisabled();
    expect(bad).toBeEnabled();

    fireEvent.click(bad);
    expect(good).toBeEnabled();
    expect(bad).toBeDisabled();
    expect(sendMessage).toHaveBeenCalledWith(
      'training-feedback',
      expect.objectContaining({
        kind: 'thumbs_down',
        previous_kind: 'thumbs_up',
        observation_id: 'obs-1',
      }),
    );
  });

  it('always offers Coco Chat first for a delegation prompt', () => {
    const onOpenCocoChat = jest.fn();
    render(
      <ObservationBubble
        bubble={{
          status: 'inefficient',
          phrase: 'Delegate this task',
          fadingOut: false,
          suggestion: {
            kind: 'delegate',
            title: 'Ask an AI tool',
            prompt: 'Explain this error.',
            copyText: 'Explain this error.',
            availableTools: [
              { id: 'chatgpt', label: 'ChatGPT', category: 'chatbot' },
              { id: 'claude', label: 'Claude', category: 'chatbot' },
            ],
          },
        }}
        onOpenCocoChat={onOpenCocoChat}
      />,
    );

    const actions = screen
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(actions.indexOf('Open Coco Chat')).toBeLessThan(
      actions.indexOf('Open ChatGPT'),
    );
    expect(actions).toContain('Open Claude');
    fireEvent.click(screen.getByRole('button', { name: 'Open Coco Chat' }));
    expect(onOpenCocoChat).toHaveBeenCalledTimes(1);
  });
});
