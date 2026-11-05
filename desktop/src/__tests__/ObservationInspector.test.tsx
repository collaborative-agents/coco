import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ObservationInspector from '../renderer/components/chat/ObservationInspector';

const row = {
  ts: Date.now() / 1000,
  status: 'observing',
  observation: 'Comparing two implementations.',
  observation_id: 'first',
};
function setup(snapshot: Promise<unknown> = Promise.resolve([row])) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const invoke = jest.fn(async (channel: string) => {
    if (channel === 'get-observation-inspector') return snapshot;
    if (channel === 'get-coco-sleep-mode') return { sleeping: false };
    return { success: true, sleeping: true };
  });
  (window as any).electron = {
    ipcRenderer: {
      invoke,
      on: (channel: string, callback: (...args: unknown[]) => void) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
    },
  };
  render(<ObservationInspector onOpen={jest.fn()} />);
  return { listeners, invoke };
}

it('stays closed during updates, then shows live observations and restores focus on Escape', async () => {
  const { listeners } = setup();
  await act(async () => {});
  act(() =>
    listeners.get('observation-update')?.({
      ...row,
      observation: 'Reading the test results.',
      observation_id: 'second',
    }),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: /Your activity/ });
  fireEvent.click(button);
  expect(screen.getByText('Reading the test results.')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Comparing two implementations.',
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});

it('does not overwrite a live observation with a delayed initial snapshot', async () => {
  let finishSnapshot!: (value: unknown) => void;
  const { listeners } = setup(
    new Promise((resolve) => {
      finishSnapshot = resolve;
    }),
  );
  await act(async () => {
    listeners.get('observation-update')?.({
      ...row,
      observation: 'New live context.',
      observation_id: 'second',
    });
    finishSnapshot([row]);
  });
  fireEvent.click(screen.getByRole('button', { name: /Your activity/ }));
  expect(screen.getByText('New live context.')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveTextContent(row.observation);
});

it('shows formatted current and earlier activity together without a history button', async () => {
  setup(
    Promise.resolve([
      {
        ...row,
        observation:
          '**Comparing implementations**\n\n- Reviewing `router.ts`\n- Checking results',
      },
      {
        ...row,
        observation_id: 'older',
        observation: 'Reviewing an earlier draft.',
      },
    ]),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByText('Comparing implementations').tagName).toBe('STRONG');
  expect(screen.getByText('router.ts').tagName).toBe('CODE');
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === 'P' &&
        element.textContent === 'Reviewing an earlier draft.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Recent activity' }),
  ).not.toBeInTheDocument();
});

it('animates only while awake with fresh observations, even when the panel is closed', async () => {
  jest.useFakeTimers();
  const { listeners } = setup();
  await act(async () => {});
  const dots = screen
    .getByRole('button', { name: 'Your activity' })
    .querySelector('.activity-logo-more');
  expect(dots).toHaveClass('is-observing');
  act(() => listeners.get('coco-sleep-mode-changed')?.({ sleeping: true }));
  expect(dots).not.toHaveClass('is-observing');
  act(() => listeners.get('coco-sleep-mode-changed')?.({ sleeping: false }));
  expect(dots).toHaveClass('is-observing');
  await act(async () => {
    jest.advanceTimersByTime(315000);
  });
  expect(dots).not.toHaveClass('is-observing');
  jest.useRealTimers();
});

it('dismisses on an outside click and reopens at the latest activity', async () => {
  setup();
  await act(async () => {});
  const trigger = screen.getByRole('button', { name: 'Your activity' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(
    screen.getByText(
      (_, element) =>
        element?.tagName === 'P' && element.textContent === row.observation,
    ),
  );
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === 'P' && element.textContent === row.observation,
    ),
  ).toBeVisible();
});

it('keeps older history across live updates and reveals more entries on scroll', async () => {
  const rows = Array.from({ length: 65 }, (_, index) => ({
    ...row,
    ts: row.ts - index * 3600,
    observation_id: `history-${index}`,
    observation: `Saved activity ${index}`,
  }));
  const { listeners } = setup(Promise.resolve(rows));
  await act(async () => {});
  act(() =>
    listeners.get('observation-update')?.({
      ...row,
      observation_id: 'live',
      observation: 'Live activity',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  expect(screen.getByText('Saved activity 30')).toBeVisible();
  expect(screen.queryByText('Saved activity 64')).not.toBeInTheDocument();
  fireEvent.scroll(document.querySelector('.activity-popover-content')!);
  expect(screen.getByText('Saved activity 64')).toBeVisible();
});

it('jumps to an hour today beyond the initially rendered entries', async () => {
  jest.useFakeTimers();
  const evening = new Date(2026, 10, 5, 18, 0, 0);
  jest.setSystemTime(evening);
  const ts = evening.getTime() / 1000;
  const rows = Array.from({ length: 70 }, (_, index) => ({
    ...row,
    ts: ts - index * 60,
    observation_id: `today-${index}`,
    observation: `Today entry ${index}`,
  }));
  setup(
    Promise.resolve([
      ...rows,
      {
        ...row,
        ts: ts - 86400,
        observation_id: 'yesterday',
        observation: 'Yesterday entry',
      },
    ]),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  expect(screen.queryByText('Today entry 61')).not.toBeInTheDocument();
  const nowButton = screen.getByRole('button', { name: 'Now' });
  expect(nowButton).toHaveAttribute('aria-current', 'time');
  const hour = screen.getByRole('button', { name: 'Jump to 16:00 today' });
  fireEvent.click(hour);
  expect(screen.getByText('Today entry 61')).toBeInTheDocument();
  expect(hour).toHaveAttribute('aria-current', 'time');
  expect(nowButton).not.toHaveAttribute('aria-current');
  const older = screen.getByRole('button', { name: /Jump to Nov 4, 2026 18:00/ });
  fireEvent.click(older);
  expect(screen.getByText('Yesterday entry')).toBeInTheDocument();
  expect(older).toHaveAttribute('aria-current', 'time');
  expect(older).toHaveTextContent('Nov 4, 2026 18:00');
  fireEvent.click(nowButton);
  expect(nowButton).toHaveAttribute('aria-current', 'time');
  expect(hour).not.toHaveAttribute('aria-current');
  expect(document.querySelector('.activity-popover-content')?.scrollTop).toBe(
    0,
  );
  jest.useRealTimers();
});
