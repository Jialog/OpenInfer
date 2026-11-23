// Statistics.accepted_external_tokens: output tokens the server took from the helper.
// Null is unknown and shows nothing; a measured zero is shown as zero. No speed estimate or speedup is derived.
import type {Statistics, U64} from '@/api/types';

export function helperShare(statistics: Statistics | undefined, outputTokens: U64): string | null {
  const accepted = statistics?.accepted_external_tokens;
  if (accepted === null || accepted === undefined) return null;
  const used = BigInt(accepted);
  const total = BigInt(outputTokens);
  if (total === 0n) return null;
  const percent = (used * 200n + total) / (total * 2n);   // rounded half up
  return `The server used ${used} ${used === 1n ? 'token' : 'tokens'} written by the helper (of ${total}, ${percent}%).`;
}
