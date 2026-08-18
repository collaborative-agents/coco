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
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Rules')).toBeInTheDocument();
    expect(
      screen.queryByText(/Stage: You are updating payroll/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show Description suggestion' }),
    );

    expect(
      screen.getByText(/Stage: You are updating payroll/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open Claude Cowork' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open Claude Code' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Back to Delegation and Description overview',
      }),
    );

    expect(screen.getByText('Delegation')).toBeInTheDocument();
  });
});

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
