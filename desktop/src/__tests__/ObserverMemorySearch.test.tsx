import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ObserverContext } from '../renderer/components/PersonalizationKnowledge';
import ScreenHistorySettings from '../renderer/components/chat/ScreenHistorySettings';

const page = {
  success: true,
  total: 0,
  matchedTotal: 0,
  groups: [],
  items: [],
  leaf: true,
  breadcrumbs: [],
};
function setup(search: () => Promise<unknown>, enabled = true) {
  let historyEnabled = enabled;
  const listeners: Array<(value: unknown) => void> = [];
  const invoke = jest.fn(async (channel, input) => {
    if (channel === 'get-screen-history-settings')
      return { success: true, enabled: historyEnabled };
    if (channel === 'get-observer-context') return page;
    if (channel === 'search-observer-memory') return search();
    if (channel === 'set-screen-history-enabled') {
      historyEnabled = input.enabled;
      const value = { success: true, enabled: historyEnabled };
      listeners.forEach((listener) => listener(value));
      return value;
    }
    throw new Error('Unexpected channel');
  });
  (window as any).electron = {
    ipcRenderer: {
      invoke,
      on: (_channel: string, listener: (value: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    },
  };
  return invoke;
}

it('uses one search bar, searches on submit, and shows screenshot evidence', async () => {
  let finish: (value: unknown) => void = () => {};
  const invoke = setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<ObserverContext />);
  await screen.findByText('Screenshots on');
  expect(
    screen.queryByRole('button', { name: 'Browse saved context' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Ask memory' })).toBeNull();
  expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  const input = screen.getByRole('searchbox', {
    name: 'Search observer context',
  });
  fireEvent.change(input, {
    target: { value: 'When does my internship end?' },
  });
  expect(
    invoke.mock.calls.some(([name]) => name === 'search-observer-memory'),
  ).toBe(false);
  fireEvent.submit(input.closest('form')!);
  expect(invoke).toHaveBeenCalledWith('search-observer-memory', {
    question: 'When does my internship end?',
  });
  expect(screen.getByRole('button', { name: 'Search memory' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('reading the evidence');
  await act(async () =>
    finish({
      success: true,
      answer: 'Your internship ends **December 18** [1].',
      model: 'local',
      sources: [
        {
          number: 1,
          time: '2026-11-24 11:14:19',
          ts: 1795547659,
          imageUrl: 'data:image/jpeg;base64,c2NyZWVu',
        },
      ],
    }),
  );
  expect(screen.getByText('December 18')).toBeVisible();
  screen.getByRole('button', { name: 'View source 1' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'View source 1' }));
  expect(screen.getByRole('dialog', { name: 'Screen 1' })).toBeVisible();
  expect(screen.getByRole('img', { name: /Source 1/ })).toHaveAttribute(
    'src',
    'data:image/jpeg;base64,c2NyZWVu',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
  expect(screen.getByRole('button', { name: 'Fit to view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'View source 1' })).toHaveFocus();
});

it('lets the status indicator turn screenshot indexing off and keeps keyword search', async () => {
  const invoke = setup(async () => ({ success: true }));
  render(<ObserverContext />);
  await screen.findByText('Screenshots on');
  fireEvent.click(screen.getByRole('switch', { name: 'Screenshot history' }));
  await screen.findByText('Screenshots off');
  expect(invoke).toHaveBeenCalledWith('set-screen-history-enabled', {
    enabled: false,
  });
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'reports' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('get-observer-context', {
      query: 'reports',
      groupBy: 'topic',
      trail: [],
    }),
  );
  expect(
    invoke.mock.calls.some(([name]) => name === 'search-observer-memory'),
  ).toBe(false);
});

it('shows the local-model setup error without a fabricated answer', async () => {
  setup(async () => ({
    success: false,
    error: 'Choose a local screen-understanding model in Settings.',
  }));
  render(<ObserverContext />);
  await screen.findByText('Screenshots on');
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'What was I reading?' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'local screen-understanding model',
  );
  expect(screen.queryByRole('article')).toBeNull();
});

it('does not load model-authored remote images', async () => {
  setup(async () => ({
    success: true,
    answer: 'No evidence. ![remote](https://example.com/tracker.png)',
    model: 'local',
    sources: [],
  }));
  render(<ObserverContext />);
  await screen.findByText('Screenshots on');
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'Anything saved?' } });
  fireEvent.submit(input.closest('form')!);
  expect(
    await screen.findByText('No supporting screenshots were found.'),
  ).toBeVisible();
  expect(screen.queryByRole('img')).toBeNull();
});

it('links known citations, preserves code and links, and switches screenshot evidence', async () => {
  setup(async () => ({
    success: true,
    answer:
      'Evidence [1, 2]. Unknown [9]. Code `[1]`. [Documentation](https://example.com).\n\n```text\n[2]\n```',
    model: 'local',
    sources: [1, 2].map((number) => ({
      number,
      time: `2026-11-24 11:14:0${number}`,
      ts: 1795547659 + number,
      imageUrl: `data:image/jpeg;base64,c2NyZWVu${number}`,
    })),
  }));
  render(<ObserverContext />);
  await screen.findByText('Screenshots on');
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'What did I read?' } });
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: 'View source 2' });
  expect(screen.getAllByRole('button', { name: /View source/ })).toHaveLength(
    2,
  );
  expect(screen.queryByRole('button', { name: 'View source 9' })).toBeNull();
  expect(screen.getByText('[1]', { selector: 'code' })).toBeVisible();
  expect(screen.getByText('[2]', { selector: 'code' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  fireEvent.click(screen.getByRole('button', { name: 'View source 2' }));
  expect(screen.getByRole('dialog', { name: 'Screen 2' })).toBeVisible();
  expect(screen.getByRole('img', { name: /Source 2/ })).toHaveAttribute(
    'src',
    'data:image/jpeg;base64,c2NyZWVu2',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show source 1' }));
  expect(screen.getByRole('dialog', { name: 'Screen 1' })).toBeVisible();
  expect(screen.getByRole('img', { name: /Source 1/ })).toHaveAttribute(
    'src',
    'data:image/jpeg;base64,c2NyZWVu1',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2 sources ↗' }));
  expect(screen.getByRole('dialog', { name: 'Screen 1' })).toBeVisible();
});

it('exposes the same persistent toggle in Memory settings', async () => {
  const invoke = setup(async () => ({}));
  render(<ScreenHistorySettings />);
  const toggle = screen.getByRole('switch', {
    name: 'Save searchable screenshot history',
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(invoke).toHaveBeenCalledWith('set-screen-history-enabled', {
    enabled: false,
  });
});
