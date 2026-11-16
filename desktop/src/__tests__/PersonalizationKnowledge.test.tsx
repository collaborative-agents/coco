import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  LearnedPreferences,
  ObserverContext,
} from '../renderer/components/PersonalizationKnowledge';

it('shows approved memory, searches sections, and links to pending review', () => {
  const onReview = jest.fn();
  render(
    <LearnedPreferences
      memory={{
        content:
          '## How to support\n- Keep explanations concise.\n\n## When to support\n- Help with reports.',
      }}
      pendingCount={2}
      onReview={onReview}
    />,
  );
  expect(screen.getAllByText('Keep explanations concise.')[0]).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'reports' },
  });
  expect(screen.queryAllByText('Keep explanations concise.')).toHaveLength(0);
  expect(screen.getAllByText('Help with reports.')[0]).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: /2 new preferences to review/ }),
  );
  expect(onReview).toHaveBeenCalled();
});

it('shows an honest empty state when no preferences have been approved', () => {
  render(
    <LearnedPreferences
      memory={{ content: '' }}
      pendingCount={0}
      onReview={jest.fn()}
    />,
  );
  expect(screen.getByText('A little more you, over time')).toBeVisible();
  expect(screen.queryByText('In use')).toBeNull();
});

it('loads observer evidence on demand and recovers from an unavailable service', async () => {
  const invoke = jest
    .fn()
    .mockResolvedValueOnce({ success: false, error: 'Service unavailable' })
    .mockResolvedValue({
      success: true,
      leaf: true,
      breadcrumbs: [],
      total: 1,
      matchedTotal: 1,
      groups: [
        { id: 'Writing & editing', label: 'Writing & editing', count: 1 },
      ],
      items: [
        {
          id: 1,
          text: 'Working on reports.',
          reasoning: 'Repeated editing.',
          updatedAt: 100,
          evidenceCount: 1,
          evidence: [
            { id: 'o1', content: 'Editing the monthly report.', createdAt: 90 },
          ],
        },
      ],
    });
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ObserverContext />);
  expect(await screen.findByText('Service unavailable')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  const insight = await screen.findByText('Working on reports.', {
    selector: 'summary > span',
  });
  fireEvent.click(insight);
  expect(insight).toBeVisible();
  fireEvent.click(screen.getByText('Why Coco remembers this'));
  expect(screen.getByText('Editing the monthly report.')).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'reports' },
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('get-observer-context', {
      query: 'reports',
      groupBy: 'topic',
      trail: [],
    }),
  );
});

it('shows a compact graph without redundant headings or manual grouping controls', async () => {
  const invoke = jest.fn().mockResolvedValue({
    success: true,
    leaf: false,
    breadcrumbs: [],
    total: 3494,
    matchedTotal: 3494,
    items: [],
    groups: [
      { id: 'Development', label: 'Development', count: 2000 },
      { id: 'Writing & editing', label: 'Writing & editing', count: 1494 },
    ],
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ObserverContext />);
  expect(
    await screen.findByRole('region', { name: 'Observer context graph' }),
  ).toBeVisible();
  expect(screen.getByText('3,494')).toBeVisible();
  expect(screen.queryByText('Previous')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Topic' })).toBeNull();
  expect(
    screen.queryByRole('heading', { name: 'What Coco has noticed' }),
  ).toBeNull();
});

it('focuses on nested groups and reveals insights only at a leaf, with breadcrumb navigation', async () => {
  const invoke = jest.fn(async (_channel, input) => {
    const depth = input.trail.length;
    return {
      success: true,
      matchedTotal: 100,
      total: depth === 0 ? 100 : depth === 1 ? 40 : 2,
      leaf: depth === 2,
      breadcrumbs:
        depth === 0
          ? []
          : depth === 1
            ? [{ label: 'Development', count: 40 }]
            : [
                { label: 'Development', count: 40 },
                { label: 'VS Code', count: 2 },
              ],
      groups:
        depth === 0
          ? [{ id: 'Development', label: 'Development', count: 40 }]
          : depth === 1
            ? [{ id: 'VS Code', label: 'VS Code', count: 2 }]
            : [],
      items:
        depth === 2
          ? [
              {
                id: 1,
                text: 'Debugging a task.',
                reasoning: '',
                updatedAt: 100,
                evidenceCount: 0,
                evidence: [],
              },
            ]
          : [],
    };
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ObserverContext />);
  fireEvent.click(
    await screen.findByRole('button', { name: '40 Development' }),
  );
  expect(
    await screen.findByRole('button', { name: '2 VS Code' }),
  ).toBeVisible();
  expect(screen.queryByText('Debugging a task.')).toBeNull();
  expect(screen.queryByText('View all')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2 VS Code' }));
  expect(
    await screen.findByText('Debugging a task.', {
      selector: 'summary > span',
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole('region', { name: 'Observer context graph' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Development 40' }));
  expect(
    await screen.findByRole('button', { name: '2 VS Code' }),
  ).toBeVisible();
  expect(invoke).toHaveBeenLastCalledWith('get-observer-context', {
    query: '',
    groupBy: 'topic',
    trail: ['Development'],
  });
});

it('refreshes visible context without hiding the graph and stops polling when unmounted', async () => {
  jest.useFakeTimers();
  const visibility = jest
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue('visible');
  const result = {
    success: true,
    leaf: false,
    breadcrumbs: [],
    total: 20,
    matchedTotal: 20,
    items: [],
    groups: [{ id: 'Development', label: 'Development', count: 20 }],
  };
  const invoke = jest.fn().mockResolvedValue(result);
  (window as any).electron = { ipcRenderer: { invoke } };
  const view = render(<ObserverContext />);
  try {
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    let complete: (value: typeof result) => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent(window, new Event('focus'));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('region', { name: 'Observer context graph' }),
    ).toBeVisible();
    expect(screen.queryByText('Loading saved context…')).toBeNull();
    await act(async () => complete(result));
    visibility.mockReturnValue('hidden');
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    view.unmount();
    fireEvent(window, new Event('focus'));
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    visibility.mockRestore();
    jest.useRealTimers();
  }
});

it('keeps the original preference version while editing and retains failed drafts', async () => {
  const invoke = jest
    .fn()
    .mockResolvedValueOnce({ success: false, error: 'Preferences changed' })
    .mockResolvedValue({ success: true });
  (window as any).electron = { ipcRenderer: { invoke } };
  const onChanged = jest.fn().mockResolvedValue(undefined);
  const props = { pendingCount: 0, onReview: jest.fn(), onChanged };
  const original = '## Support\n- Original.\n- Other.';
  const { rerender } = render(
    <LearnedPreferences {...props} memory={{ content: original }} />,
  );
  fireEvent.click(screen.getAllByText('Original.')[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
  screen.getByRole('textbox', { name: 'Edit preference' }).textContent =
    'Edited.';
  fireEvent.input(screen.getByRole('textbox', { name: 'Edit preference' }));
  rerender(
    <LearnedPreferences
      {...props}
      memory={{ content: '## Support\n- Newer.\n- Other.' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Preferences changed',
  );
  expect(invoke).toHaveBeenCalledWith('save-active-preferences', {
    expected: original,
    content: '## Support\n- Edited.\n\n- Other.',
  });
  expect(screen.getByRole('textbox')).toHaveTextContent('Edited.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  expect(invoke).toHaveBeenCalledTimes(1);
  const dialog = screen.getByRole('dialog', {
    name: 'Delete this preference?',
  });
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(invoke).toHaveBeenLastCalledWith('save-active-preferences', {
    expected: '## Support\n- Newer.\n- Other.',
    content: '## Support\n- Other.',
  });
});

it('edits and deletes observer insights through the saved-memory channel', async () => {
  let text = 'Original insight.';
  let deleted = false;
  const invoke = jest.fn(async (channel, input) => {
    if (channel === 'change-observer-insight') {
      expect(input.expected).toBe(text);
      if (input.text === null) deleted = true;
      else text = input.text;
      return { success: true };
    }
    if (!input.trail.length)
      return {
        success: true,
        leaf: false,
        groups: [{ id: 'Development', label: 'Development', count: 9 }],
        breadcrumbs: [],
        matchedTotal: 9,
        total: 9,
        items: [],
      };
    return {
      success: true,
      leaf: true,
      groups: [],
      breadcrumbs: [{ label: 'Development', count: 1 }],
      matchedTotal: deleted ? 0 : 1,
      total: deleted ? 0 : 1,
      items: deleted
        ? []
        : [
            {
              id: 9,
              text,
              updatedAt: 100,
              reasoning: '',
              evidenceCount: 0,
              evidence: [],
            },
          ],
    };
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<ObserverContext />);
  fireEvent.click(await screen.findByRole('button', { name: '9 Development' }));
  fireEvent.click(
    await screen.findByText('Original insight.', {
      selector: 'summary > span',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  screen.getByRole('textbox').textContent = 'Corrected insight.';
  fireEvent.input(screen.getByRole('textbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const edited = await screen.findByText('Corrected insight.', {
    selector: 'summary > span',
  });
  expect(edited.closest('details')).toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'Development 1' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(await screen.findByText('No insights in this group')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Development 0' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'get-observer-context'),
  ).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith('change-observer-insight', {
    id: 9,
    expected: 'Corrected insight.',
    text: null,
  });
});
