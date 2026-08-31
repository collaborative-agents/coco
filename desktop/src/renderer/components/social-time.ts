const EXPLICIT_TIME_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;

/**
 * The social API stores timestamps in UTC, but some responses omit the `Z`
 * suffix. Normalize those values before constructing a Date so the renderer
 * can reliably convert them to the desktop's local timezone.
 */
export function parseSocialTimestamp(value: string): Date {
  const timestamp = value.trim();
  const normalized =
    timestamp.includes('T') && !EXPLICIT_TIME_ZONE.test(timestamp)
      ? `${timestamp}Z`
      : timestamp;
  return new Date(normalized);
}

export function socialTimestampMs(value: string): number {
  return parseSocialTimestamp(value).getTime();
}

export function formatSocialTime(value: string): string {
  const timestamp = parseSocialTimestamp(value);
  return Number.isNaN(timestamp.getTime())
    ? ''
    : timestamp.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
}
