import { render, screen } from '@testing-library/react';
import ConversationSidebar from '../renderer/components/chat/ConversationSidebar';

it('hides workspace-only drafts while keeping conversations with screenshots', () => {
  render(
    <ConversationSidebar
      conversations={[
        {
          sessionId: 'empty',
          problem: 'General help session',
          createdAt: 1,
          updatedAt: 1,
          messages: [],
        },
        {
          sessionId: 'image',
          title: 'Screenshot discussion',
          problem: '',
          createdAt: 1,
          updatedAt: 1,
          messages: [{ role: 'user', text: '', images: ['image'] }],
        },
      ]}
      loading={false}
      error={false}
      selectedId={undefined}
      onSelect={jest.fn()}
      onRetry={jest.fn()}
      onCurrent={jest.fn()}
    />,
  );
  expect(screen.queryByText('General help session')).toBeNull();
  expect(screen.getByText('Screenshot discussion')).toBeTruthy();
});

it('shows the empty history state when only drafts are saved', () => {
  render(
    <ConversationSidebar
      conversations={[
        {
          sessionId: 'empty',
          problem: '',
          createdAt: 1,
          updatedAt: 1,
          messages: [],
        },
      ]}
      loading={false}
      error={false}
      selectedId={undefined}
      onSelect={jest.fn()}
      onRetry={jest.fn()}
      onCurrent={jest.fn()}
    />,
  );
  expect(
    screen.getByText('Your past conversations will appear here.'),
  ).toBeTruthy();
});
