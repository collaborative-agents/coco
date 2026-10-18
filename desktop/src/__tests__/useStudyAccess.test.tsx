import { renderHook, waitFor } from '@testing-library/react';
import useStudyAccess from '../renderer/useStudyAccess';

it.each([true, false])('uses verified policy %s', async (allowed) => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue({ tutoring_allowed: allowed, status: allowed ? 'allowed' : 'disabled' }),
      },
    },
  });
  const { result } = renderHook(() => useStudyAccess());
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toBe(allowed));
});
it('fails closed if IPC is unavailable', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: {
        invoke: jest.fn().mockRejectedValue(new Error('offline')),
      },
    },
  });
  const { result } = renderHook(() => useStudyAccess());
  await waitFor(() => expect(result.current).toBe('unavailable'));
});

it('does not describe a failed policy fetch as an admin restriction', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke: jest.fn().mockResolvedValue({ tutoring_allowed: false, status: 'unavailable' }) } },
  });
  const { result } = renderHook(() => useStudyAccess());
  await waitFor(() => expect(result.current).toBe('unavailable'));
});
