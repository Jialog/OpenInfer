// Every number the pages show goes through here, so units and precision stay the same everywhere.
import type {Time, U64} from '@/api/types';

/** Capacity in GiB with one decimal. */
export function formatBytes(bytes: U64 | null): string {
  if (bytes === null) return 'unknown';
  return `${(Number(bytes) / 2 ** 30).toFixed(1)} GiB`;
}

/** Throughput in whole Mbit/s from a transfer of `bytes` over `ms`. */
export function formatMbps(bytes: U64, ms: number): string {
  return `${((Number(bytes) * 8) / (ms * 1000)).toFixed(0)} Mbit/s`;
}

/** A round trip time with two decimals. */
export function formatRoundTrip(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

/** Tokens per second with one decimal; null is a speed that cannot be measured yet. */
export function formatTokensPerSecond(value: number | null): string {
  return value === null ? 'Not available' : `${value.toFixed(1)} tok/s`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];
const relative = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});

/** "5 minutes ago", "in 30 seconds"; within five seconds either way is "just now". */
export function formatRelative(time: Time, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(time) - now) / 1000);
  if (Math.abs(seconds) < 5) return 'just now';
  const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? UNITS[UNITS.length - 1];
  return relative.format(Math.trunc(seconds / size), unit);
}

/** Date and time in the browser's locale. */
export function formatLocalTime(time: Time): string {
  return new Date(time).toLocaleString();
}
