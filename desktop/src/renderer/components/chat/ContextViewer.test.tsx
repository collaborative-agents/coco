import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import ContextViewer from './ContextViewer';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});

test('opens session-scoped analysis on demand and restores focus on close', async () => {
  const invoke = jest.fn().mockResolvedValue({
    estimatedTokens: 120,
    reported: { contextWindow: 64000 },
    categories: [
      {
        id: 'tools',
        label: 'Tools',
        tokens: 120,
        entries: [
          { breadcrumb: ['bash'], tokens: 120, text: 'Tool schema content' },
        ],
      },
    ],
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ContextViewer sessionId="saved-session" />);
  expect(invoke).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Context' });
  fireEvent.click(button);
  expect(await screen.findByText('Tool schema content')).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith('get-agent-context', 'saved-session');
  expect(screen.getByRole('dialog')).toHaveAttribute('open');
  expect(
    screen.getByText('Tool schema content').closest('details'),
  ).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Close context' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});

test('reads context again when reopened after a failed read', async () => {
  const invoke = jest
    .fn()
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValueOnce(null);
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ContextViewer sessionId="archive" />);
  fireEvent.click(screen.getByRole('button', { name: 'Context' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed');
  fireEvent.click(screen.getByRole('button', { name: 'Close context' }));
  fireEvent.click(screen.getByRole('button', { name: 'Context' }));
  expect(
    await screen.findByText(/Send a message in this session/),
  ).toBeInTheDocument();
});
