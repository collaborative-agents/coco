import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ToolCallDetails from './ToolCallDetails';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});

const script = Array.from(
  { length: 24 },
  (_, index) => `print("line ${index}")`,
).join('\n');
const call = {
  id: 'internal-call-id',
  name: 'python',
  arguments: { script },
  status: 'completed' as const,
  result: { output: 'Finished' },
};

test('previews long scripts and opens all source with syntax highlighting', async () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copy },
  });
  const { container } = render(<ToolCallDetails call={call} />);
  expect(container).not.toHaveTextContent('internal-call-id');
  expect(container).not.toHaveTextContent('line 23');
  const expand = screen.getByRole('button', { name: 'Show full script' });
  expect(expand).toHaveTextContent('+ 20 lines');
  expand.focus();
  fireEvent.click(expand);
  const modal = screen.getByRole('dialog', { name: 'python · Script' });
  expect(modal.querySelector('code')?.textContent).toBe(script);
  expect(modal.querySelector('.hljs-string')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Copied'),
  );
  expect(copy).toHaveBeenCalledWith(script);
  fireEvent.click(screen.getByRole('button', { name: 'Close code window' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(expand).toHaveFocus();
  fireEvent.click(expand);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('bounds a long single line and preserves HTML-like source as text', () => {
  const source = '<script>alert("hi")</script>'.repeat(30);
  const { container } = render(
    <ToolCallDetails call={{ ...call, arguments: { code: source } }} />,
  );
  expect(container.querySelector('pre')!.textContent!.length).toBeLessThan(170);
  fireEvent.click(screen.getByRole('button', { name: 'Show full code' }));
  const modal = screen.getByRole('dialog');
  expect(modal.querySelector('code')!.textContent).toBe(source);
  expect(modal.querySelector('script')).toBeNull();
});

test('keeps errors visible and expands long output independently', () => {
  render(
    <ToolCallDetails
      call={{
        ...call,
        arguments: { command: 'exit 1' },
        status: 'error',
        result: { error: 'Command failed', output: script },
      }}
    />,
  );
  expect(screen.getByText('Command failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show full output' }));
  expect(
    screen
      .getByRole('dialog', { name: 'python · Output' })
      .querySelector('code')!.textContent,
  ).toBe(script);
});

test('explains short commands inline and reuses the explanation', async () => {
  const explanation =
    'Searches the Documents folder for PDFs and shows the first 60 matches.';
  const invoke = jest.fn().mockResolvedValue({ explanation });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
  render(
    <ToolCallDetails
      call={{
        ...call,
        name: 'bash',
        arguments: { command: 'find ~/Documents -name "*.pdf" | head -60' },
      }}
    />,
  );
  expect(screen.queryByRole('button', { name: /Open/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(explanation),
  );
  expect(invoke).toHaveBeenCalledWith('explain-tool-command', {
    tool: 'bash',
    source: 'find ~/Documents -name "*.pdf" | head -60',
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Hide explanation' }));
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
  expect(screen.getByRole('status')).toHaveTextContent(explanation);
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('allows retry when explanation fails', async () => {
  const invoke = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      explanation: 'Lists files in the current folder.',
    });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
  render(<ToolCallDetails call={{ ...call, arguments: { command: 'ls' } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Try again'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Lists files'),
  );
});
