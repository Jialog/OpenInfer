import {describe, expect, it} from 'vitest';
import {formatBytes, formatMbps, formatRelative, formatRoundTrip, formatTokensPerSecond} from './format';

describe('number formats', () => {
  it('keeps two decimals for a round trip', () => {
    expect(formatRoundTrip(0.4023140063509345)).toBe('0.40 ms');
    expect(formatRoundTrip(12)).toBe('12.00 ms');
  });

  it('rounds bandwidth to whole Mbit/s', () => {
    // 8,000,000 bytes in 64 ms = 1000 Mbit/s; 8,000,000 bytes in 69.3 ms = 923.5... Mbit/s.
    expect(formatMbps('8000000', 64)).toBe('1000 Mbit/s');
    expect(formatMbps('8000000', 69.3)).toBe('924 Mbit/s');
  });

  it('shows capacity in GiB with one decimal', () => {
    expect(formatBytes(String(15 * 2 ** 30))).toBe('15.0 GiB');
    expect(formatBytes('24159191040')).toBe('22.5 GiB');
    expect(formatBytes(null)).toBe('unknown');
  });

  it('shows speed in tok/s with one decimal', () => {
    expect(formatTokensPerSecond(29.2876)).toBe('29.3 tok/s');
    expect(formatTokensPerSecond(null)).toBe('Not available');
  });

  it('says how long ago a time was', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(formatRelative('2026-11-11T11:59:58Z', now)).toBe('just now');
    expect(formatRelative('2026-11-11T11:55:00Z', now)).toBe('5 minutes ago');
    expect(formatRelative('2026-11-11T10:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelative('2026-11-08T12:00:00Z', now)).toBe('3 days ago');
    expect(formatRelative('2026-11-11T12:00:30Z', now)).toBe('in 30 seconds');
  });
});
