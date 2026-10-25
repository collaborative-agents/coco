import {
  retryOperation,
  RetryCancelledError,
} from '../main/services/retry-operation';

describe('retryOperation', () => {
  it('retries a startup failure and returns the eventual result', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('ready');
    const sleep = jest.fn(async () => undefined);

    await expect(
      retryOperation(operation, {
        delaysMs: [0, 500, 1000],
        sleep,
      }),
    ).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when the owning session is no longer active', async () => {
    let active = true;
    const operation = jest.fn(async () => {
      active = false;
      throw new Error('ECONNREFUSED');
    });

    await expect(
      retryOperation(operation, {
        delaysMs: [0, 500],
        shouldContinue: () => active,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(RetryCancelledError);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
