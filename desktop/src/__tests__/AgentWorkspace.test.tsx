import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentWorkspace from '../renderer/components/chat/AgentWorkspace';
import { SuggestionMessage } from '../renderer/components/chat/MessageContent';

it('chooses a folder and keeps the previous folder when the dialog is cancelled', async () => {
  let selected: { directory: string } | null = { directory: '/work/reports' };
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-agent-workspace'
      ? { directory: '/work/project' }
      : selected,
  );
  (window as any).electron = { ipcRenderer: { invoke } };
  render(
    <AgentWorkspace
      sessionId="session-a"
      disabled={false}
      running={false}
      onStop={jest.fn()}
    />,
  );
  await screen.findByText('project');
  fireEvent.click(
    screen.getByRole('button', { name: 'Choose working folder' }),
  );
  await screen.findByText('reports');
  expect(invoke).toHaveBeenCalledWith('choose-agent-workspace', {
    sessionId: 'session-a',
  });
  selected = null;
  fireEvent.click(
    screen.getByRole('button', { name: 'Choose working folder' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Choose working folder' }),
    ).toBeEnabled(),
  );
  expect(screen.getByText('reports')).toBeInTheDocument();
});

it('reloads the working folder when the selected conversation changes', async () => {
  const invoke = jest.fn(
    async (_channel: string, { sessionId }: { sessionId: string }) => ({
      directory: sessionId === 'session-a' ? '/work/project' : '/work/reports',
    }),
  );
  (window as any).electron = { ipcRenderer: { invoke } };
  const { rerender } = render(
    <AgentWorkspace
      key="session-a"
      sessionId="session-a"
      disabled={false}
      running={false}
      onStop={jest.fn()}
    />,
  );
  await screen.findByText('project');
  rerender(
    <AgentWorkspace
      key="session-b"
      sessionId="session-b"
      disabled={false}
      running={false}
      onStop={jest.fn()}
    />,
  );
  await screen.findByText('reports');
  expect(screen.queryByText('project')).not.toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith('get-agent-workspace', {
    sessionId: 'session-b',
  });
});

it('disables folder changes during execution and forwards Stop', async () => {
  (window as any).electron = {
    ipcRenderer: {
      invoke: jest.fn(async () => ({ directory: '/work/project' })),
    },
  };
  const stop = jest.fn(async () => {});
  render(
    <AgentWorkspace sessionId="session-a" disabled running onStop={stop} />,
  );
  await screen.findByText('project');
  expect(
    screen.getByRole('button', { name: 'Choose working folder' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
});

it('only runs a proactive suggestion after an explicit click', () => {
  const run = jest.fn();
  const props = {
    suggestion: {
      kind: 'delegate' as const,
      title: 'Analyze the file',
      copyText: 'Analyze sales.csv',
    },
    folded: false,
    onToggleFold: jest.fn(),
    onRun: run,
  };
  const { rerender } = render(
    <SuggestionMessage
      suggestion={props.suggestion}
      folded={false}
      onToggleFold={props.onToggleFold}
      onRun={run}
    />,
  );
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run with Coco' }));
  expect(run).toHaveBeenCalledTimes(1);
  rerender(
    <SuggestionMessage
      suggestion={props.suggestion}
      folded={false}
      onToggleFold={props.onToggleFold}
      onRun={run}
      runDisabled
    />,
  );
  expect(screen.getByRole('button', { name: 'Run with Coco' })).toBeDisabled();
});
