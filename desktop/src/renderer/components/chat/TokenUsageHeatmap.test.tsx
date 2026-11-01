import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import TokenUsageHeatmap, {
  buildTokenCalendar,
  localDayKey,
} from './TokenUsageHeatmap';
import type { TokenUsageRecord } from '../../../shared/token-usage';

test('lays out 365 local days in full Sunday-first weeks and retains partial model usage', () => {
  const now = new Date(2026, 9, 29, 12);
  const request: TokenUsageRecord = {
    requestId: 'r',
    sessionId: 's',
    at: now.toISOString(),
    model: 'a',
    input: null,
    output: 10,
    successful: true,
    models: [
      { model: 'a', input: null, output: 10 },
      { model: 'b', input: 20, output: 5 },
    ],
  };
  const days = buildTokenCalendar([request], now);
  expect(days.length % 7).toBe(0);
  expect(days[0].date.getDay()).toBe(0);
  expect(days.filter((day) => day.active)).toHaveLength(365);
  expect(days.find((day) => day.key === '2026-10-29')).toMatchObject({
    tokens: 35,
    missing: true,
    level: 4,
    active: true,
  });
  expect(
    days.filter((day) => day.key > '2026-10-29').every((day) => !day.active),
  ).toBe(true);
});

test('supports selecting a day, clearing the filter, and arrow-key navigation', () => {
  const onSelect = jest.fn();
  const today = localDayKey(new Date());
  const { container, rerender } = render(
    <TokenUsageHeatmap requests={[]} selected={null} onSelect={onSelect} />,
  );
  const active = container.querySelector<HTMLButtonElement>(
    'button[tabindex="0"]',
  )!;
  fireEvent.keyDown(active, { key: 'ArrowLeft' });
  expect(document.activeElement).not.toBe(active);
  expect(document.activeElement).toHaveAttribute(
    'data-day-index',
    String(Number(active.dataset.dayIndex) - 7),
  );
  fireEvent.click(active);
  expect(onSelect).toHaveBeenCalledWith(today);
  rerender(
    <TokenUsageHeatmap requests={[]} selected={today} onSelect={onSelect} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show full year' }));
  expect(onSelect).toHaveBeenLastCalledWith(null);
});
