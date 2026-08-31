import {
  formatSocialTime,
  parseSocialTimestamp,
  socialTimestampMs,
} from '../renderer/components/social-time';

describe('social timestamps', () => {
  it('treats timezone-less API timestamps as UTC', () => {
    expect(parseSocialTimestamp('2026-08-27T12:01:00').toISOString()).toBe(
      '2026-08-27T12:01:00.000Z',
    );
    expect(socialTimestampMs('2026-08-27T12:01:00')).toBe(
      socialTimestampMs('2026-08-27T12:01:00Z'),
    );
  });

  it('preserves timestamps that already contain an explicit offset', () => {
    expect(parseSocialTimestamp('2026-08-27T12:01:00-07:00').toISOString()).toBe(
      '2026-08-27T19:01:00.000Z',
    );
  });

  it('formats the normalized instant using the desktop locale', () => {
    const formatter = jest
      .spyOn(Date.prototype, 'toLocaleTimeString')
      .mockImplementation(function localTime(this: Date) {
        return this.toISOString();
      });

    expect(formatSocialTime('2026-08-27T12:01:00')).toBe(
      '2026-08-27T12:01:00.000Z',
    );
    expect(formatter).toHaveBeenCalledWith([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    formatter.mockRestore();
  });
});
