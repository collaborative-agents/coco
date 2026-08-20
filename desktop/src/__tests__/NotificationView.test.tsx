/**
 * NotificationBubble rendering tests
 *
 * Covers:
 *  1. Plain text / markdown
 *  2. JSON envelope parsing  (new "guidance" key & old "Text guidance" key)
 *  3. LaTeX rendering via remark-math + rehype-katex
 *  4. LaTeX embedded inside a JSON guidance string (with unescaped backslashes
 *     that the LLM commonly produces)
 *  5. Fenced code rendering
 *
 * NOTE: these tests require remark-math@6 (compatible with react-markdown@10).
 * If you see `exitMathText … Cannot set properties of undefined` run:
 *   npm install --ignore-scripts   (inside desktop/)
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import NotificationView, {
  NotificationBubble,
} from '../renderer/components/NotificationView';
import type { InstantSuggestion } from '../renderer/components/observation-types';

// ---------------------------------------------------------------------------
// 1. Plain text / Markdown
// ---------------------------------------------------------------------------
describe('plain text and markdown', () => {
  it('renders a simple string', () => {
    render(<NotificationBubble message="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders markdown bold without showing asterisks', () => {
    const { container } = render(
      <NotificationBubble message="This is **bold** text." />,
    );
    expect(container.querySelector('strong')).toBeInTheDocument();
    expect(container.textContent).not.toContain('**');
  });

  it('renders markdown italic', () => {
    const { container } = render(
      <NotificationBubble message="This is *italic* text." />,
    );
    expect(container.querySelector('em')).toBeInTheDocument();
  });

  it('handles an empty message without crashing', () => {
    const { container } = render(<NotificationBubble message="" />);
    expect(container).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. JSON envelope parsing
// ---------------------------------------------------------------------------
describe('JSON envelope parsing', () => {
  it('unwraps the "guidance" key (new format)', () => {
    const msg = JSON.stringify({
      guidance: 'Use the force!',
      visualization_url: null,
    });
    render(<NotificationBubble message={msg} />);
    expect(screen.getByText('Use the force!')).toBeInTheDocument();
  });

  it('unwraps the "Text guidance" key (old format)', () => {
    const msg = JSON.stringify({
      'Text guidance': 'Old-format guidance text',
      'python visualization code': '',
    });
    render(<NotificationBubble message={msg} />);
    expect(screen.getByText('Old-format guidance text')).toBeInTheDocument();
  });

  it('does not leak raw JSON keys or braces to the user', () => {
    const msg = JSON.stringify({
      guidance: 'Clean output here',
      visualization_url: null,
      example_prompt: 'not applicable',
    });
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.textContent).not.toContain('"guidance"');
    expect(container.textContent).not.toContain('visualization_url');
    expect(container.textContent).not.toContain('example_prompt');
  });

  it('extracts guidance from JSON wrapped in a ```json fence', () => {
    const msg = '```json\n{"guidance": "Fenced guidance text"}\n```';
    render(<NotificationBubble message={msg} />);
    expect(screen.getByText('Fenced guidance text')).toBeInTheDocument();
  });

  it('extracts guidance from JSON embedded after prose', () => {
    const msg =
      'Here is my analysis:\n{"guidance": "Embedded after prose", "visualization_url": null}';
    render(<NotificationBubble message={msg} />);
    expect(screen.getByText('Embedded after prose')).toBeInTheDocument();
  });

  it('falls back to rendering raw text when no JSON is present', () => {
    const msg = 'Just a plain message with no JSON at all.';
    render(<NotificationBubble message={msg} />);
    expect(
      screen.getByText('Just a plain message with no JSON at all.'),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. LaTeX rendering (plain markdown, not inside JSON)
// ---------------------------------------------------------------------------
describe('LaTeX rendering in plain markdown', () => {
  it('renders inline math without crashing', () => {
    const { container } = render(
      <NotificationBubble message="The policy $\pi_{HL}$ is the high-level policy." />,
    );
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders display math without crashing', () => {
    // remark-math v6 requires $$ markers on their own lines for block (display) math
    const { container } = render(
      <NotificationBubble message={'$$\nE = mc^2\n$$'} />,
    );
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('renders fractions', () => {
    const { container } = render(
      <NotificationBubble message="Loss: $\frac{1}{n} \sum_i L_i$" />,
    );
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders Greek letters', () => {
    const { container } = render(
      <NotificationBubble message="Parameters: $\theta, \alpha, \beta$" />,
    );
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders subscripts and superscripts', () => {
    const { container } = render(
      <NotificationBubble message="Memory token $m_t$ updates each step." />,
    );
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('does not show raw dollar signs for valid math', () => {
    const { container } = render(
      <NotificationBubble message="See $\pi_{LL}$ for details." />,
    );
    // KaTeX replaces the $…$ node — raw $ should not appear in visible text
    expect(container.textContent).not.toContain('$\\pi_{LL}$');
  });
});

// ---------------------------------------------------------------------------
// 4. LaTeX inside JSON guidance (the tricky LLM-output case)
//    LLMs commonly emit \frac, \theta etc. without doubling the backslash,
//    so repairJsonEscapes() must fix those before JSON.parse().
// ---------------------------------------------------------------------------
describe('LaTeX inside JSON guidance', () => {
  it('renders inline LaTeX inside a JSON guidance string', () => {
    // Valid JSON with properly escaped backslash
    const msg = JSON.stringify({
      guidance: 'The high-level policy $\\pi_{HL}$ drives the arm.',
    });
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('handles LLM-style unescaped LaTeX in JSON (repairJsonEscapes path)', () => {
    // Simulate what an LLM emits: \frac is not doubled in the JSON string
    const raw = '{"guidance": "Minimize $\\frac{1}{N}\\sum_i L_i$ at each step."}';
    const { container } = render(<NotificationBubble message={raw} />);
    // Should still render — either via repaired JSON or fallback
    expect(container).toBeTruthy();
    expect(container.textContent).not.toContain('"guidance"');
  });

  it('renders display math inside JSON guidance', () => {
    // remark-math v6 requires $$ markers on their own lines for block (display) math
    const msg = JSON.stringify({
      guidance: '$$\nm_t = f(m_{t-1}, o_t)\n$$',
    });
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('renders mixed text and LaTeX inside JSON guidance', () => {
    const msg = JSON.stringify({
      guidance:
        'The **low-level policy** $\\pi_{LL}$ takes semantic cues from $m_t$ and visual input to produce motor commands.',
    });
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.querySelector('strong')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Fenced code rendering
// ---------------------------------------------------------------------------
describe('fenced code rendering', () => {
  it('shows python fenced code blocks', () => {
    const msg =
      'Here is some guidance.\n\n```python\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\n```';
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.textContent).toContain('import matplotlib');
    expect(container.textContent).toContain('plt.plot');
    expect(container.querySelector('code.language-python')).toBeInTheDocument();
  });

  it('shows py fenced code blocks', () => {
    const msg = 'Guidance text.\n\n```py\nprint("hello")\n```';
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.textContent).toContain('print("hello")');
    expect(container.querySelector('code.language-py')).toBeInTheDocument();
  });

  it('still shows inline code that is not a viz block', () => {
    const msg = 'Try calling `train()` first.';
    render(<NotificationBubble message={msg} />);
    expect(screen.getByText('train()')).toBeInTheDocument();
  });
});

describe('instant suggestion actions', () => {
  const contentSuggestion: InstantSuggestion = {
    kind: 'content',
    title: 'Try a smaller example',
    body: 'Reduce the input before debugging the full workflow.',
    copyText: 'Reduce the input before debugging the full workflow.',
  };

  it('previews only the title before the full suggestion is revealed', () => {
    const onReveal = jest.fn();
    const { container } = render(
      <NotificationBubble
        message={contentSuggestion.title}
        actionLabel="Reveal full suggestion"
        notifType="proactive-suggestion"
        suggestion={contentSuggestion}
        onAction={onReveal}
        adjustable
      />,
    );

    expect(screen.getByText(contentSuggestion.title)).toBeInTheDocument();
    expect(screen.getByText('Suggestion')).toBeInTheDocument();
    expect(
      container.querySelector('.toast-card--suggestion-preview'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Expand notification' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(contentSuggestion.body!)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Chat about it' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Reveal full suggestion →' }),
    );
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('offers to continue a content suggestion in chat', () => {
    const onChat = jest.fn();
    render(
      <NotificationBubble
        message="Try a smaller example"
        actionLabel="Copy"
        notifType="instant-suggestion"
        suggestion={contentSuggestion}
        onChatAboutSuggestion={onChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the opposite rating available for a correction', () => {
    const onRate = jest.fn();
    render(
      <NotificationBubble
        message="Try a smaller example"
        actionLabel="Copy"
        notifType="instant-suggestion"
        suggestion={contentSuggestion}
        suggestionRating="up"
        onRateSuggestion={onRate}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Good suggestion' }),
    ).toBeDisabled();
    const bad = screen.getByRole('button', { name: 'Not helpful' });
    expect(bad).toBeEnabled();
    fireEvent.click(bad);
    expect(onRate).toHaveBeenCalledWith('down');
  });

  it('offers Coco Chat as the default delegation destination', () => {
    const onOpenCocoChat = jest.fn();
    const onChat = jest.fn();
    render(
      <NotificationBubble
        message="Ask an AI tool"
        notifType="instant-suggestion"
        suggestion={{
          kind: 'delegate',
          title: 'Ask an AI tool',
          prompt: 'Explain this error.',
          copyText: 'Explain this error.',
          targetTool: 'claude-code',
          availableTools: [
            { id: 'claude-cowork', label: 'Claude Cowork', category: 'agent' },
            { id: 'claude-code', label: 'Claude Code', category: 'agent' },
          ],
        }}
        onOpenCocoChat={onOpenCocoChat}
        onChatAboutSuggestion={onChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Open Claude Code' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open Claude Cowork' }),
    ).not.toBeInTheDocument();
    const coco = screen.getByRole('button', { name: 'Open Coco Chat' });
    expect(coco).toHaveClass('toast-coco-chat-action');
    fireEvent.click(coco);
    expect(onOpenCocoChat).toHaveBeenCalledTimes(1);
  });

  it('shows the 4D overview before an AI-upskilling suggestion', () => {
    const onPageChange = jest.fn();
    render(
      <NotificationBubble
        message="Ask an AI tool"
        notifType="proactive-suggestion"
        suggestion={{
          kind: 'delegate',
          title: 'Description: diagnose the failed build',
          prompt:
            'Stage: A GitHub Actions packaging job failed on an M-chip Mac.\nTask: Diagnose the console error and identify the likely cause.\nRules: Use the visible error evidence and do not suggest deleting user data.',
          copyText:
            'Stage: A GitHub Actions packaging job failed on an M-chip Mac.\nTask: Diagnose the console error and identify the likely cause.\nRules: Use the visible error evidence and do not suggest deleting user data.',
          targetTool: 'chatgpt',
          availableTools: [
            { id: 'chatgpt', label: 'ChatGPT', category: 'chatbot' },
          ],
        }}
        showFrameworkIntro
        frameworkPage={0}
        onFrameworkPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Delegation')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Diagnose the console error and identify the likely cause/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /GitHub Actions packaging job failed.*visible error evidence/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/^Stage: A GitHub Actions packaging job failed/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show Description suggestion' }),
    );
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('grounds a Discernment overview in the current suggestion', () => {
    render(
      <NotificationBubble
        message="Check the generated command"
        notifType="proactive-suggestion"
        suggestion={{
          kind: 'content',
          title: 'Discernment: verify before running',
          body: 'Before running the generated Git command, verify the target repository and branch, then check that it will not overwrite unrelated work.',
          copyText:
            'Before running the generated Git command, verify the target repository and branch, then check that it will not overwrite unrelated work.',
        }}
        showFrameworkIntro
      />,
    );

    expect(screen.getByText('Discernment')).toBeInTheDocument();
    expect(screen.queryByText('Delegation')).not.toBeInTheDocument();
    expect(
      screen.getByText(/verify the target repository and branch/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show coaching suggestion' }),
    ).toBeInTheDocument();
  });

  it('uses a left arrow to return from the Description suggestion', () => {
    const onPageChange = jest.fn();
    render(
      <NotificationBubble
        message={'**Ask an AI tool**\n\nExplain this error.'}
        notifType="instant-suggestion"
        suggestion={{
          kind: 'delegate',
          title: 'Ask an AI tool',
          prompt: 'Explain this error.',
          copyText: 'Explain this error.',
          availableTools: [],
        }}
        showFrameworkIntro
        frameworkPage={1}
        onFrameworkPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Explain this error.')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Back to Delegation and Description overview',
      }),
    );
    expect(onPageChange).toHaveBeenCalledWith(0);
  });
});

describe('window controls', () => {
  it('offers expand and collapse controls for an adjustable notification', () => {
    const onToggleExpanded = jest.fn();
    const { rerender } = render(
      <NotificationBubble
        message="Adjust me"
        adjustable
        expanded={false}
        onToggleExpanded={onToggleExpanded}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand notification' }),
    );
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);

    rerender(
      <NotificationBubble
        message="Adjust me"
        adjustable
        expanded
        onToggleExpanded={onToggleExpanded}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Collapse notification' }),
    ).toBeInTheDocument();
  });

  it('does not show an expand control for a fixed notification', () => {
    render(<NotificationBubble message="Fixed" />);
    expect(
      screen.queryByRole('button', { name: 'Expand notification' }),
    ).not.toBeInTheDocument();
  });

  it('reveals the full message when expanded', () => {
    const message = `${'Preview text '.repeat(20)}full-message-ending`;
    const { rerender } = render(
      <NotificationBubble message={message} adjustable expanded={false} />,
    );
    expect(screen.queryByText(/full-message-ending/)).not.toBeInTheDocument();

    rerender(<NotificationBubble message={message} adjustable expanded />);
    expect(screen.getByText(/full-message-ending/)).toBeInTheDocument();
  });
});

describe('interactive notification locking', () => {
  it('locks replacements while the first framework page is displayed', () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const sendMessage = jest.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: {
          sendMessage,
          invoke: jest.fn(),
          on: (channel: string, callback: (...args: any[]) => void) => {
            listeners.set(channel, callback);
            return () => listeners.delete(channel);
          },
        },
      },
    });

    render(<NotificationView />);
    act(() => {
      listeners.get('notification')?.({
        message: 'This task could use AI support.',
        actionLabel: 'Reveal full suggestion',
        notifType: 'proactive-suggestion',
        observationId: 'obs-1',
        status: 'inefficient',
        scenario: 'ai_upskilling',
        suggestion: {
          kind: 'content',
          title: 'Draft a clear request',
          body: 'Include the context and constraints.',
          copyText: 'Include the context and constraints.',
        },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'proactive-suggestion-open-state',
      { open: true },
    );
    expect(
      screen.getByRole('button', { name: 'Show coaching suggestion' }),
    ).toBeInTheDocument();
  });
});
