// Speeds from a request's timing. Counters are U64 strings, so durations use BigInt.
import {formatTokensPerSecond} from '@/lib/format';
import type {Timing, U64} from '@/api/types';

export type Speed = {endToEnd: number | null; decode: number | null};

function perSecond(tokens: bigint, startNs: U64 | null, endNs: U64 | null): number | null {
  if (startNs === null || endNs === null || tokens <= 0n) return null;
  const elapsedNs = BigInt(endNs) - BigInt(startNs);
  if (elapsedNs <= 0n) return null;
  return Number(tokens) / (Number(elapsedNs) / 1e9);
}

export function computeSpeed(timing: Timing, outputTokens: U64): Speed {
  const tokens = BigInt(outputTokens);
  const firstChunk = timing.engine_first_chunk_tokens;
  return {
    endToEnd: perSecond(tokens, timing.engine_received_ns, timing.engine_last_output_ns),
    decode:
      firstChunk === null
        ? null
        : perSecond(tokens - BigInt(firstChunk), timing.engine_first_output_ns, timing.engine_last_output_ns),
  };
}

export function formatSpeed(value: number | null): string {
  return formatTokensPerSecond(value);
}
