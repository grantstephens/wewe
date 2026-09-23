import { formatTimestamp } from './timestamp';

describe('formatTimestamp', () => {
  it('renders RFC3339 UTC with no fractional seconds', () => {
    expect(formatTimestamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });

  it('is lexicographically ordered the same as chronological order', () => {
    const earlier = formatTimestamp(new Date('2026-01-02T03:04:05Z'));
    const later = formatTimestamp(new Date('2026-01-02T03:04:06Z'));
    expect(earlier < later).toBe(true);
  });
});
