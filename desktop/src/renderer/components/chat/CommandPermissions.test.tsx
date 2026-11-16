import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CommandPermissions from './CommandPermissions';

test('lists workspace rules and revokes the selected rule', async () => {
  const invoke = jest.fn(async (channel: string) => ({
    directory: '/workspace',
    rules:
      channel === 'list-command-approvals'
        ? [{ id: 'rule-1', directory: '/workspace', prefix: ['npm', 'test'] }]
        : [],
  }));
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<CommandPermissions sessionId="chat-1" onClose={jest.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Remove npm test approval' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'revoke-command-approval',
      'chat-1',
      'rule-1',
    ),
  );
  expect(
    await screen.findByText('No saved command approvals.'),
  ).toBeInTheDocument();
});

test('lists saved outside-file permissions and revokes them separately from command rules', async () => {
  const invoke = jest.fn(async (channel: string) => ({
    directory: '/workspace',
    rules: [],
    fileRules:
      channel === 'list-command-approvals'
        ? [
            {
              id: 'file-1',
              directory: '/workspace',
              kind: 'path',
              fileAccess: {
                path: '/other/report.txt',
                scope: 'file',
                mode: 'read',
              },
            },
          ]
        : [],
  }));
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<CommandPermissions sessionId="chat-1" onClose={jest.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Remove access to /other/report.txt',
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'revoke-file-approval',
      'chat-1',
      'file-1',
    ),
  );
  expect(
    await screen.findByText('No saved file permissions.'),
  ).toBeInTheDocument();
});
