import {
  MAX_FATAL_ERROR_MESSAGE_LENGTH,
  sanitizeFatalErrorMessage,
} from './fatal-error-telemetry';

describe('sanitizeFatalErrorMessage', () => {
  it('redacts configured credentials and common inline secret formats', () => {
    const message = sanitizeFatalErrorMessage(
      'key=managed-secret-value Bearer session-token sk-abcdefgh12345678 ' +
        'https://example.test/fail?api_key=query-secret&mode=1',
      [{ OBSERVER_API_KEY: 'managed-secret-value' }],
    );

    expect(message).not.toContain('managed-secret-value');
    expect(message).not.toContain('session-token');
    expect(message).not.toContain('sk-abcdefgh12345678');
    expect(message).not.toContain('query-secret');
    expect(message).toContain('[redacted]');
  });

  it('bounds uploaded diagnostics and supplies an empty-message fallback', () => {
    expect(sanitizeFatalErrorMessage('')).toBe(
      'Service terminated without an error message.',
    );
    expect(sanitizeFatalErrorMessage('x'.repeat(5000))).toHaveLength(
      MAX_FATAL_ERROR_MESSAGE_LENGTH,
    );
  });
});
