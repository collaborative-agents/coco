import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import SessionChatView from '../renderer/components/SessionChatView';

jest.mock('../renderer/components/PersonalizationCenter', () => ({
  __esModule: true,
  default: () => <div>Personalization content</div>,
  PersonalizationSettingsCard: () => <div>Personalization settings</div>,
}));

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

it('provides chat and personalization without a personalization prerequisite', async () => {
  render(<SessionChatView />);
  expect(screen.getByPlaceholderText(/Ask Coco/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Training tasks' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Start a new session' })).toBeEnabled();
  await act(async () => listeners.get('open-personalization-panel')?.());
  expect(screen.getByText('Personalization content')).toBeVisible();
  expect(invoke).not.toHaveBeenCalledWith('study-access');
});

it('shows only the selected tab and preserves the chat draft across navigation', async () => {
  render(<SessionChatView />);
  const draft = screen.getByPlaceholderText(/Ask Coco/);
  fireEvent.change(draft, { target: { value: 'Keep my thought here' } });
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
  expect(draft).toBeVisible();
  expect(sendMessage).toHaveBeenLastCalledWith('toggle-float-window', {
    expanded: false,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  expect(screen.getByText('Personalization content')).toBeVisible();
  expect(draft).not.toBeVisible();
  expect(draft).toHaveValue('Keep my thought here');
  expect(sendMessage).toHaveBeenLastCalledWith('toggle-float-window', {
    expanded: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
  expect(draft).toBeVisible();
  expect(draft).toHaveValue('Keep my thought here');
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get-profile'));
});

it('opens settings and personalization as separate pages without the chat pane', async () => {
  render(<SessionChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
  expect(screen.queryByText('Personalization settings')).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith('get-personalization-center');
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText(/Ask Coco/)).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  expect(screen.getByText('Personalization content')).toBeVisible();
  expect(screen.getByPlaceholderText(/Ask Coco/)).not.toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get-profile'));
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

it('synchronizes native resizing and external personalization navigation', async () => {
  render(<SessionChatView />);
  await act(async () =>
    listeners.get('float-window-state')?.({ isFloat: true }),
  );
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Expand' })).toBeVisible();
  await act(async () => listeners.get('open-personalization-panel')?.());
  expect(screen.getByText('Personalization content')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Personalization' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(screen.getByPlaceholderText(/Ask Coco/)).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(screen.getByText('Personalization content')).toBeVisible();
  expect(screen.getByPlaceholderText(/Ask Coco/)).not.toBeVisible();
});

it('switches from personalization to chat when opening a saved conversation', async () => {
  invoke.mockImplementation(async (channel) =>
    channel === 'get-chat-conversations'
      ? [
          {
            sessionId: 'saved',
            title: 'Earlier chat',
            updatedAt: 1753200000000,
            messages: [{ role: 'tutor', text: 'Your saved answer' }],
          },
        ]
      : null,
  );
  render(<SessionChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Chat' }));
  expect(screen.getByText('Personalization content')).toBeVisible();
  fireEvent.click(await screen.findByText('Earlier chat'));
  expect(screen.getByText('Your saved answer')).toBeVisible();
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
});

it('reveals chat when a practice task starts a chat session', async () => {
  render(<SessionChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  await act(async () =>
    listeners.get('session-init')?.({
      sessionId: 'practice',
      problemStatement: 'Practice together',
    }),
  );
  expect(screen.getByPlaceholderText(/Ask Coco/)).toBeVisible();
  expect(screen.queryByText('Personalization content')).not.toBeInTheDocument();
});


it('keeps navigation visible and closes the window without navigating to chat', async () => {
  render(<SessionChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Personalization' }).querySelector('svg'))
    .toHaveAttribute('data-header-icon', 'personalization');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(sendMessage).toHaveBeenLastCalledWith('close-chat-window');
  expect(screen.getByText('Personalization content')).toBeVisible();
  await act(async () => {});
});
