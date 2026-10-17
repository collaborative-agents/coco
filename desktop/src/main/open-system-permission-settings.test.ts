import { openSystemPermissionSettings } from './open-system-permission-settings';

function deps(status = 'denied') {
  return {
    screenStatus: () => status,
    requestScreenAccess: jest.fn().mockResolvedValue([]),
    openExternal: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn(),
  };
}

afterEach(() => jest.useRealTimers());
it.each(['denied', 'not-determined', 'unknown'])(
  'requests screen access for an ungranted status (%s) before opening settings',
  async (status) => {
    const d = deps(status);
    await openSystemPermissionSettings('screen-recording', d);
    expect(d.requestScreenAccess).toHaveBeenCalledTimes(1);
    expect(d.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(d.requestScreenAccess.mock.invocationCallOrder[0]).toBeLessThan(
      d.openExternal.mock.invocationCallOrder[0],
    );
  },
);
it.each(['granted', 'restricted'])(
  'does not repeat a decided permission request (%s)',
  async (status) => {
    const d = deps(status);
    await openSystemPermissionSettings('screen-recording', d);
    expect(d.requestScreenAccess).not.toHaveBeenCalled();
    expect(d.openExternal).toHaveBeenCalledTimes(1);
  },
);
it('still opens settings when capture fails', async () => {
  const d = deps();
  d.requestScreenAccess.mockRejectedValue(new Error('denied'));
  await openSystemPermissionSettings('screen-recording', d);
  expect(d.warn).toHaveBeenCalled();
  expect(d.openExternal).toHaveBeenCalledTimes(1);
});
it('does not get stuck waiting for unanswered native consent', async () => {
  jest.useFakeTimers();
  const d = deps();
  d.requestScreenAccess.mockReturnValue(new Promise(() => {}));
  const result = openSystemPermissionSettings('screen-recording', d);
  await jest.advanceTimersByTimeAsync(3000);
  await result;
  expect(d.openExternal).toHaveBeenCalledTimes(1);
});
it('does not request screen access from the Accessibility button', async () => {
  const d = deps();
  await openSystemPermissionSettings('accessibility', d);
  expect(d.requestScreenAccess).not.toHaveBeenCalled();
  expect(d.openExternal).toHaveBeenCalledWith(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  );
});
it('surfaces settings launch failures for the manual-instructions fallback', async () => {
  const d = deps('denied');
  d.openExternal.mockRejectedValue(new Error('launch failed'));
  await expect(
    openSystemPermissionSettings('screen-recording', d),
  ).rejects.toThrow('launch failed');
});
