import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ActionTooltip from './ActionTooltip';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('explains disabled icons on hover without changing their action state', () => {
  render(
    <ActionTooltip label="Attach files">
      <button type="button" disabled aria-label="Attach">
        +
      </button>
    </ActionTooltip>,
  );
  const button = screen.getByRole('button', { name: 'Attach' });
  fireEvent.mouseEnter(button.parentElement!);
  act(() => jest.advanceTimersByTime(250));
  expect(screen.getByRole('tooltip')).toHaveTextContent('Attach files');
  expect(button).toBeDisabled();
  fireEvent.mouseLeave(button.parentElement!);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

it('dismisses with Escape or a click without staying pinned by focus', () => {
  render(
    <ActionTooltip label="View context">
      <button type="button">Context</button>
    </ActionTooltip>,
  );
  const button = screen.getByRole('button', { name: 'Context' });
  fireEvent.mouseEnter(button.parentElement!);
  act(() => jest.advanceTimersByTime(250));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.mouseLeave(button.parentElement!);
  fireEvent.mouseEnter(button.parentElement!);
  act(() => jest.advanceTimersByTime(250));
  fireEvent.click(button);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
