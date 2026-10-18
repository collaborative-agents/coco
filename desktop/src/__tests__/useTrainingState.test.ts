import { act, renderHook } from '@testing-library/react';
import useTrainingState from '../renderer/components/training/useTrainingState';

const account = { user_id: 'alice', role: 'participant', days: [] };
let invoke: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  invoke = jest.fn(async (channel: string) =>
    channel === 'study-me' ? account : { enabled: false },
  );
  (window as any).electron = { ipcRenderer: { invoke } };
});
afterEach(() => jest.useRealTimers());

it('does not request account data during hidden startup, then loads immediately on first open', async () => {
  let signedIn = false;
  invoke.mockImplementation(async (channel: string) => {
    if (!signedIn) throw new Error('Please sign in to continue.');
    return channel === 'study-me' ? account : { enabled: false };
  });
  const { result, rerender } = renderHook(
    ({ visible }) => useTrainingState(visible, 0),
    { initialProps: { visible: false } },
  );
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(invoke).not.toHaveBeenCalled();
  signedIn = true;
  await act(async () => {
    rerender({ visible: true });
  });
  expect(invoke).toHaveBeenCalledWith('study-me');
  expect(result.current.state).toEqual(account);
  expect(result.current.error).toBe('');
});

it('polls only while visible and refreshes immediately on returning', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ visible }) => useTrainingState(visible, 0),
    { initialProps: { visible: true } },
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(invoke).toHaveBeenCalledTimes(4);
  rerender({ visible: false });
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(result.current.state).toEqual(account);
  await act(async () => {
    rerender({ visible: true });
  });
  expect(invoke).toHaveBeenCalledTimes(6);
  unmount();
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(invoke).toHaveBeenCalledTimes(6);
});

it('clears an earlier sign-in error and retries on another menu open, even on the same tab', async () => {
  invoke.mockRejectedValueOnce(new Error('Please sign in to continue.'));
  const { result, rerender } = renderHook(
    ({ key }) => useTrainingState(true, key),
    { initialProps: { key: 0 } },
  );
  await act(async () => {});
  expect(result.current.error).toBe('Please sign in to continue.');
  await act(async () => {
    rerender({ key: 1 });
  });
  expect(result.current.error).toBe('');
  expect(result.current.state).toEqual(account);
  expect(invoke).toHaveBeenCalledTimes(4);
});

it('ignores a late failure from an earlier visit after a successful refresh', async () => {
  let rejectOld!: (reason: Error) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        rejectOld = reject;
      }),
  );
  const { result, rerender } = renderHook(
    ({ visible }) => useTrainingState(visible, 0),
    { initialProps: { visible: true } },
  );
  rerender({ visible: false });
  await act(async () => {
    rerender({ visible: true });
  });
  expect(result.current.state).toEqual(account);
  await act(async () => {
    rejectOld(new Error('Please sign in to continue.'));
  });
  expect(result.current.state).toEqual(account);
  expect(result.current.error).toBe('');
});
