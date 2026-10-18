import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import ObservationBubble, {
  BubbleState,
} from '../renderer/components/ObservationBubble';

describe('ObservationBubble 4D suggestion pages', () => {
  const bubble: BubbleState = {
    status: 'inefficient',
    phrase: 'This task could be delegated.',
    fadingOut: false,
    scenario: 'ai_upskilling',
    suggestion: {
      kind: 'delegate',
      title: 'Description: give AI a precise task',
      prompt:
        'Stage: You are updating payroll.\nTask: Read the policy and update the spreadsheet.\nRules: Follow the rounding policy.',
      copyText:
        'Stage: You are updating payroll.\nTask: Read the policy and update the spreadsheet.\nRules: Follow the rounding policy.',
      targetTool: 'claude-cowork',
      availableTools: [
        { id: 'claude-cowork', label: 'Claude Cowork', category: 'agent' },
        { id: 'claude-code', label: 'Claude Code', category: 'agent' },
      ],
    },
  };

  it('shows the concepts before the prompt and navigates in both directions', () => {
    render(<ObservationBubble bubble={bubble} />);

    expect(screen.getByText('Delegation')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Claude Cowork.*Read the policy and update the spreadsheet/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You are updating payroll.*Follow the rounding policy/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Stage: You are updating payroll/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Copy prompt' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show me how →' }));

    expect(
      screen.getByText(/Stage: You are updating payroll/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open Claude Cowork' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open Claude Code' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '← Why' }));

    expect(screen.getByText('Delegation')).toBeInTheDocument();
  });
});

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
    expect(good).toHaveAttribute('aria-pressed', 'true');
    expect(bad).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(bad);
    expect(good).toHaveAttribute('aria-pressed', 'false');
    expect(bad).toHaveAttribute('aria-pressed', 'true');
    expect(sendMessage).toHaveBeenCalledWith(
      'training-feedback',
      expect.objectContaining({
        kind: 'thumbs_down',
        previous_kind: 'thumbs_up',
        observation_id: 'obs-1',
      }),
    );
  });

  it('offers only copying and chatting as suggestion actions', () => {
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
      />,
    );

    const actions = screen
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(actions).toContain('Copy prompt');
    expect(actions).toContain('Chat with Coco');
    expect(actions).not.toContain('Run with Coco');
    expect(actions).not.toContain('Open ChatGPT');
    expect(actions).not.toContain('Open Claude');
    expect(actions).not.toContain('Open Coco Chat');
  });
});
