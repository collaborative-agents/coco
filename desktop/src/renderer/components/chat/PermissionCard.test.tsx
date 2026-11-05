import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PermissionCard from './PermissionCard';
import type { PermissionRequest } from '../../../shared/agent-execution';

const invoke = jest.fn();
const request: PermissionRequest = {
  id: 'approval-1',
  kind: 'action',
  tool: 'bash',
  arguments: { command: 'git push origin main' },
  directory: '/work',
  status: 'pending',
};
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
});

test('shows the exact command and requires explicit one-time approval', async () => {
  render(<PermissionCard request={request} requestId="run-1" interactive />);
  expect(screen.getByText('git push origin main')).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'answer-agent-permission',
      'run-1',
      'approval-1',
      true,
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull(),
  );
  expect(screen.queryByText('git push origin main')).toBeNull();
});

test('workspace card denies through the dedicated permission channel', async () => {
  render(
    <PermissionCard
      request={{ ...request, kind: 'workspace' }}
      requestId="run-1"
      interactive
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Allow folder access' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'answer-agent-permission',
      'run-1',
      'approval-1',
      false,
    ),
  );
});

test('historical and cancelled requests have no active approval controls', () => {
  const { rerender } = render(
    <PermissionCard request={request} requestId="run-1" interactive={false} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  rerender(
    <PermissionCard
      request={{ ...request, status: 'cancelled' }}
      requestId="run-1"
      interactive
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
});

test('denied requests collapse to a neutral status line without a card or buttons', () => {
  const { container } = render(
    <PermissionCard
      request={{ ...request, kind: 'workspace', status: 'denied' }}
      requestId="run-1"
      interactive={false}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Denied by the user');
  expect(screen.getByText('Read and edit folder')).toBeTruthy();
  expect(screen.getByText('/work')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(container.querySelector('.agent-permission-card')).toBeNull();
});

test('failed submission shows an error and allows retry', async () => {
  invoke.mockRejectedValueOnce(new Error('Connection lost'));
  render(<PermissionCard request={request} requestId="run-1" interactive />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Connection lost'),
  );
  expect(
    (screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test('denied commands retain the exact request and working folder', () => {
  render(
    <PermissionCard
      request={{ ...request, status: 'denied' }}
      requestId="run-1"
      interactive={false}
    />,
  );
  expect(screen.getByText('git push origin main')).toBeTruthy();
  expect(screen.getByText('/work')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('offers the trusted prefix and submits a reusable decision without sending its own rule', async () => {
  render(
    <PermissionCard
      request={{ ...request, suggestedPrefix: ['git', 'push'] }}
      requestId="run-1"
      interactive
    />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Always allow git push … in this workspace',
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'answer-agent-permission',
      'run-1',
      'approval-1',
      'always',
    ),
  );
});

test('hides commands automatically allowed by a saved workspace rule', () => {
  render(
    <PermissionCard
      request={{ ...request, status: 'allowed', approvalSource: 'saved-rule' }}
      requestId="run-1"
      interactive
    />,
  );
  expect(screen.queryByText('Allowed by your saved workspace rule')).toBeNull();
  expect(screen.queryByText('git push origin main')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
});

test('outside file prompt shows read scope and offers workspace-specific persistence', async () => {
  render(
    <PermissionCard
      request={{
        ...request,
        kind: 'path',
        tool: 'read',
        arguments: { path: '/other/report.txt' },
        fileAccess: { path: '/other/report.txt', scope: 'file', mode: 'read' },
      }}
      requestId="run-1"
      interactive
    />,
  );
  expect(screen.getByText('Allow read access?')).toBeTruthy();
  expect(screen.getByText('/other/report.txt')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Always allow in this workspace' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'answer-agent-permission',
      'run-1',
      'approval-1',
      'always',
    ),
  );
});

test('workspace prompt explains that the grant survives chats and restarts', () => {
  render(
    <PermissionCard
      request={{ ...request, kind: 'workspace', tool: undefined }}
      requestId="run-1"
      interactive
    />,
  );
  expect(screen.getByText(/remembered across chats and restarts/)).toBeTruthy();
});

test.each([
  ['Enter', true],
  ['Escape', false],
])(
  '%s answers a pending permission from an empty composer',
  async (key, allow) => {
    render(
      <>
        <textarea aria-label="Message" />
        <PermissionCard request={request} requestId="run-1" interactive />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'answer-agent-permission',
        'run-1',
        request.id,
        allow,
      ),
    );
  },
);

test('shortcuts preserve drafts, composition, modifiers, and focused buttons', () => {
  render(
    <>
      <textarea aria-label="Message" defaultValue="draft" />
      <PermissionCard request={request} requestId="run-1" interactive />
    </>,
  );
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Deny' }), {
    key: 'Enter',
  });
  for (const modifier of [
    'repeat',
    'isComposing',
    'shiftKey',
    'ctrlKey',
    'altKey',
    'metaKey',
  ]) {
    fireEvent.keyDown(document.body, { key: 'Enter', [modifier]: true });
  }
  expect(invoke).not.toHaveBeenCalled();
});

test('one keypress answers only the first pending request and cannot double-submit', () => {
  invoke.mockImplementation(() => new Promise(() => {}));
  render(
    <>
      <PermissionCard request={request} requestId="run-1" interactive />
      <PermissionCard
        request={{ ...request, id: 'approval-2' }}
        requestId="run-2"
        interactive
      />
    </>,
  );
  fireEvent.keyDown(document.body, { key: 'Enter' });
  fireEvent.keyDown(document.body, { key: 'Enter' });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith(
    'answer-agent-permission',
    'run-1',
    request.id,
    true,
  );
});

test('historical prompts do not respond to shortcuts', () => {
  render(
    <PermissionCard request={request} requestId="run-1" interactive={false} />,
  );
  fireEvent.keyDown(document.body, { key: 'Enter' });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(invoke).not.toHaveBeenCalled();
});
