import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import SessionChatView from '../renderer/components/SessionChatView';

const listeners = new Map<string, (payload?: unknown) => void>();
let invoke: jest.Mock;
let sendMessage: jest.Mock;
beforeEach(() => {
  listeners.clear();
  sendMessage = jest.fn();
  invoke = jest.fn(async (channel) =>
    channel === 'get-chat-conversations' ? [] : null,
  );
  (window as any).electron = {
    ipcRenderer: {
      invoke,
      sendMessage,
      on: jest.fn((channel, callback) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      }),
    },
  };
});

it('keeps history open while moving into it and dismisses it with Escape or pointer exit', async () => {
  render(<SessionChatView />);
  const chat = screen.getByRole('button', { name: 'Chat' });
  fireEvent.mouseEnter(chat);
  const history = await screen.findByRole('region', {
    name: 'Conversation history',
  });
  fireEvent.mouseLeave(chat, { relatedTarget: history });
  fireEvent.mouseEnter(history, { relatedTarget: chat });
  expect(history).toBeVisible();
  expect(screen.getByPlaceholderText(/Ask Coco/)).toBeVisible();
  await screen.findByText('Your past conversations will appear here.');
  fireEvent.keyDown(chat, { key: 'Escape' });
  expect(
    screen.queryByRole('region', { name: 'Conversation history' }),
  ).toBeNull();
  fireEvent.focus(chat);
  expect(
    await screen.findByRole('region', { name: 'Conversation history' }),
  ).toBeVisible();
  fireEvent.mouseLeave(chat.closest('.workspace-navigation')!);
  expect(
    screen.queryByRole('region', { name: 'Conversation history' }),
  ).toBeNull();
});

it('shows a retryable history error and loads saved sessions on retry', async () => {
  let attempts = 0;
  invoke.mockImplementation(async (channel) => {
    if (channel === 'get-chat-conversations') {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return [
        {
          sessionId: 'saved',
          title: 'Project ideas',
          updatedAt: 1753200000000,
          messages: [],
        },
      ];
    }
    return null;
  });
  render(<SessionChatView />);
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Chat' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Project ideas')).toBeVisible();
  expect(
    screen.queryByText('Conversation history could not be loaded.'),
  ).toBeNull();
});

it('keeps the local agent available without accounts, training, or personalization', async () => {
  render(<SessionChatView />);
  expect(screen.getByPlaceholderText(/Ask Coco/)).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Start a new session' }),
  ).toBeEnabled();
  expect(
    screen.queryByRole('button', { name: /Training|Personalization|Sign in/i }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(
    await screen.findByRole('heading', { name: 'Models & providers' }),
  ).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Account' })).toBeNull();
  for (const channel of [
    'study-access',
    'get-llm-router-status',
    'get-personalization-center',
  ])
    expect(invoke).not.toHaveBeenCalledWith(channel);
});

it('keeps a chat draft while navigating through local settings', async () => {
  render(<SessionChatView />);
  const draft = screen.getByPlaceholderText(/Ask Coco/);
  fireEvent.change(draft, { target: { value: 'Continue my project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(draft).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  expect(draft).toBeVisible();
  expect(draft).toHaveValue('Continue my project');
  await act(async () => {});
});

it('synchronizes the expand control with the window mode before the first click', async () => {
  render(<SessionChatView />);
  expect(sendMessage).toHaveBeenCalledWith('get-float-window-state');
  act(() => listeners.get('float-window-state')?.({ isFloat: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  expect(sendMessage).toHaveBeenLastCalledWith('toggle-float-window', {
    expanded: true,
  });
  act(() => listeners.get('float-window-state')?.({ isFloat: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(sendMessage).toHaveBeenLastCalledWith('toggle-float-window', {
    expanded: false,
  });
});
