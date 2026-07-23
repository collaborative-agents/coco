/**
 * NotificationBubble rendering tests
 *
 * Covers:
 *  1. Plain text / markdown
 *  2. JSON envelope parsing  (new "guidance" key & old "Text guidance" key)
 *  3. LaTeX rendering via remark-math + rehype-katex
 *  4. LaTeX embedded inside a JSON guidance string (with unescaped backslashes
 *     that the LLM commonly produces)
 *  5. Visualization code-block suppression
 *
 * NOTE: these tests require remark-math@6 (compatible with react-markdown@10).
 * If you see `exitMathText … Cannot set properties of undefined` run:
 *   npm install --ignore-scripts   (inside desktop/)
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificationBubble } from '../renderer/components/NotificationView';
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
// 5. Visualization code-block suppression
// ---------------------------------------------------------------------------
describe('visualization code suppression', () => {
  it('hides python fenced code blocks', () => {
    const msg =
      'Here is some guidance.\n\n```python\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\n```';
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.textContent).not.toContain('import matplotlib');
    expect(container.textContent).not.toContain('plt.plot');
  });

  it('hides py fenced code blocks', () => {
    const msg = 'Guidance text.\n\n```py\nprint("hello")\n```';
    const { container } = render(<NotificationBubble message={msg} />);
    expect(container.textContent).not.toContain('print("hello")');
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

  it('offers to continue a delegated suggestion in chat', () => {
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
          targetTool: 'chatgpt',
          availableTools: [],
        }}
        onChatAboutSuggestion={onChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });
});
