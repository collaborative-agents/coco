/** @jest-environment node */
import {
  startObservationStream,
  stopObservationStream,
} from './observation-stream';

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

it('does not revive a stopped observation stream when sensing is re-enabled', async () => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  try {
    const options = {
      url: 'http://127.0.0.1/observations',
      onEvent: jest.fn(),
    };
    startObservationStream(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stopObservationStream();
    startObservationStream(options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(6000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stopObservationStream();
    await jest.advanceTimersByTimeAsync(6000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    stopObservationStream();
    global.fetch = originalFetch;
    jest.useRealTimers();
  }
});
