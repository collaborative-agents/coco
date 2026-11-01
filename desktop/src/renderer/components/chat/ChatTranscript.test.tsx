import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import ChatTranscript from './ChatTranscript';
import type { ChatMessage } from './types';

jest.mock('./MessageContent', () => ({
  TutorMessage: ({ text }: { text: string }) => <span>{text}</span>,
  SuggestionMessage: () => null,
}));

function renderMessage(message: ChatMessage) {
  return render(
    <ChatTranscript
      reviewing={null}
      listRef={createRef()}
      visibleMessages={[message]}
      sending={false}
      profile={{ scenario: '', aiTools: [], hideAvatar: false }}
      startingNewSession={false}
      sendMessage={jest.fn()}
      openImagePreview={jest.fn()}
      copiedMessageKey={null}
      copyMessage={jest.fn()}
      toggleSuggestionFold={jest.fn()}
      retryMessage={jest.fn()}
      ratings={{}}
      rateMessage={jest.fn()}
      hasRunningTool={false}
      following
      onScroll={jest.fn()}
      onJumpToLatest={jest.fn()}
    />,
  );
}

test('saved workspace denial shows only the compact log, without retry or feedback', () => {
  renderMessage({
    role: 'tutor',
    text: 'Workspace access was denied. Choose a folder or try again to grant access.',
    isError: true,
    retryText: 'Do the task',
    activity: [
      {
        kind: 'permission',
        request: {
          id: 'p1',
          kind: 'workspace',
          directory: '/work',
          status: 'denied',
        },
      },
    ],
  });
  expect(screen.getByRole('status').textContent).toBe('Denied by the user');
  expect(screen.queryByText(/Choose a folder/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('actual execution failures still offer retry', () => {
  renderMessage({
    role: 'tutor',
    text: 'Service unavailable',
    isError: true,
    retryText: 'Do the task',
  });
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
