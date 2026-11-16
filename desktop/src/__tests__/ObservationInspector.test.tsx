import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

it('shows saved suggestions inline with their activity in the existing panel', async () => {
  setup(
    Promise.resolve([
      {
        ...row,
        proactive_support: {
          engaged: false,
          suggestion: {
            kind: 'content',
            title: 'Compare the results',
            body: 'Review **both outputs** before choosing.',
            copyText: 'Review both outputs before choosing.',
            dimensions: ['judgment', 'learning'],
          },
        },
      },
      {
        ...row,
        observation_id: 'delegate',
        ts: row.ts - 60,
        proactive_support: {
          engaged: true,
          suggestion: {
            kind: 'delegate',
            title: 'Ask for a review',
            prompt: 'Check `router.ts` for edge cases.',
            copyText: 'Check router.ts for edge cases.',
          },
        },
      },
    ]),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  const title = screen.getByText('Compare the results');
  const tags = within(title.closest('summary')!).getByRole('list', {
    name: 'Suggestion tags',
  });
  expect(
    within(tags)
      .getAllByRole('listitem')
      .map((tag) => tag.textContent),
  ).toEqual(['Judgment', 'Learning', 'Ready to use']);
  expect(
    screen.getByTitle('Check information or make a better decision.'),
  ).toHaveTextContent('Judgment');
  expect(screen.getByText('AI prompt')).toBeInTheDocument();
  expect(title.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(title.closest('summary')!);
  expect(title.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('both outputs').tagName).toBe('STRONG');
  expect(screen.getByText('Ask for a review')).toBeInTheDocument();
  expect(screen.getByText('router.ts').tagName).toBe('CODE');
  fireEvent.click(screen.getByRole('button', { name: 'All suggestions' }));
  expect(screen.getByText('Judgment')).toBeVisible();
  expect(screen.getByText('Learning')).toBeVisible();
  expect(screen.getByText('Ready to use')).toBeVisible();
  expect(screen.getByText('AI prompt')).toBeVisible();
  expect(screen.getAllByText('Related observation')).toHaveLength(2);
});

it('refreshes completed suggestions without losing live activity', async () => {
  jest.useFakeTimers();
  const { listeners, invoke } = setup();
  await act(async () => {});
  act(() =>
    listeners.get('observation-update')?.({
      ...row,
      observation_id: 'newer',
      observation: 'New live context.',
    }),
  );
  invoke.mockImplementation(async (channel: string) => {
    if (channel !== 'get-observation-inspector') return {};
    return [
      {
        ...row,
        proactive_support: {
          engaged: false,
          suggestion: {
            kind: 'content',
            title: 'A finished suggestion',
            body: 'Try this approach.',
            copyText: 'Try this approach.',
          },
        },
      },
    ];
  });
  await act(async () => {
    listeners.get('activity-history-changed')?.();
    jest.advanceTimersByTime(300);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  expect(screen.getByText('A finished suggestion')).toBeInTheDocument();
  expect(screen.getByText('New live context.')).toBeInTheDocument();
  expect(
    screen.getAllByText(
      (_, element) =>
        element?.tagName === 'P' && element.textContent === row.observation,
    ),
  ).toHaveLength(1);
  jest.useRealTimers();
});

it('marks suggestion hours and filters all saved suggestions before pagination', async () => {
  const rows = Array.from({ length: 85 }, (_, index) => ({
    ...row,
    ts: row.ts - index * 3600,
    observation_id: `activity-${index}`,
    observation: `Activity entry ${index}`,
    ...(index === 2 || index === 84
      ? {
          proactive_support: {
            engaged: false,
            suggestion: {
              kind: 'content',
              title: `Suggestion ${index}`,
              body: `Suggestion text ${index}`,
              copyText: `Suggestion text ${index}`,
            },
          },
        }
      : {}),
  }));
  setup(Promise.resolve(rows));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  const markers = screen.getAllByRole('button', { name: /Jump to/ });
  expect(
    markers.filter((marker) => marker.classList.contains('has-suggestions')),
  ).toHaveLength(2);
  expect(screen.queryByText('Suggestion 84')).not.toBeInTheDocument();
  const filter = screen.getByRole('button', { name: 'All suggestions' });
  expect(filter).toHaveTextContent('2');
  fireEvent.click(filter);
  expect(filter).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.queryByText('Activity entry 0')).not.toBeInTheDocument();
  expect(screen.getByText('Suggestion 84')).toBeVisible();
  expect(screen.getByText('Suggestion text 84')).toBeVisible();
  expect(screen.getByText('Suggestion 84').closest('details')).toBeNull();
  const observation = screen.getByText('Activity entry 84');
  const context = observation.closest('details')!;
  expect(context).not.toHaveAttribute('open');
  expect(observation).not.toBeVisible();
  expect(
    screen.getByText('Suggestion 84').compareDocumentPosition(context),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  fireEvent.click(context.querySelector('summary')!);
  expect(observation).toBeVisible();
  expect(context).toHaveAttribute('open');
  expect(screen.getAllByRole('button', { name: /Jump to/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
  expect(screen.getByText('Activity entry 0')).toBeVisible();
  expect(screen.queryByText('Suggestion 84')).not.toBeInTheDocument();
});

it('paginates suggestions and jumps to older suggestion hours in the filtered feed', async () => {
  setup(
    Promise.resolve(
      Array.from({ length: 85 }, (_, index) => ({
        ...row,
        ts: row.ts - index * 3600,
        observation_id: `activity-${index}`,
        observation: `Activity entry ${index}`,
        ...(index % 2 === 0
          ? {
              proactive_support: {
                engaged: false,
                suggestion: {
                  kind: 'delegate',
                  title: `Suggestion ${index}`,
                  prompt: `Prompt ${index}`,
                  copyText: `Prompt ${index}`,
                },
              },
            }
          : {}),
      })),
    ),
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'All suggestions' }));
  expect(screen.queryByText('Suggestion 84')).not.toBeInTheDocument();
  const hours = screen.getAllByRole('button', { name: /Jump to/ });
  fireEvent.click(hours[hours.length - 1]);
  expect(screen.getByText('Suggestion 84')).toBeVisible();
  expect(hours[hours.length - 1]).toHaveAttribute('aria-current', 'time');
  fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'All suggestions' }));
  fireEvent.scroll(document.querySelector('.activity-popover-content')!);
  expect(screen.getByText('Suggestion 84')).toBeVisible();
});

it('explains when there are no suggestions and keeps activity accessible', async () => {
  setup();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Your activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'All suggestions' }));
  expect(screen.getByText(/No suggestions yet/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
  expect(
    screen.getByRole('list', { name: 'Recent activity' }),
  ).toHaveTextContent(row.observation);
});

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
  const older = screen.getByRole('button', {
    name: /Jump to Nov 4, 2026 18:00/,
  });
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
