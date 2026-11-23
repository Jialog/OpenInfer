import {describe, expect, it} from 'vitest';
import {emptyTiming} from '@/test/factories';
import {computeSpeed, formatSpeed} from './speed';

// Expected values follow the formulas in speed.ts.
describe('computeSpeed', () => {
  it('computes end-to-end from engine received to last output, including prefill', () => {
    const speed = computeSpeed(
      {...emptyTiming, engine_received_ns: '1000000000', engine_first_output_ns: '2000000000',
       engine_last_output_ns: '5000000000', engine_first_chunk_tokens: 4},
      '100',
    );
    expect(speed.endToEnd).toBeCloseTo(100 / 4, 10);
  });

  it('computes decode as tokens after the first engine chunk over first-to-last output', () => {
    const speed = computeSpeed(
      {...emptyTiming, engine_received_ns: '1000000000', engine_first_output_ns: '2000000000',
       engine_last_output_ns: '5000000000', engine_first_chunk_tokens: 4},
      '100',
    );
    expect(speed.decode).toBeCloseTo(96 / 3, 10);
  });

  it('keeps nanosecond counters above 2^53 exact', () => {
    // 2^60 + 1 and 2^60 + 129: as doubles both round to 2^60, so a Number subtraction would give 0.
    const speed = computeSpeed(
      {...emptyTiming, engine_received_ns: '1152921504606846977', engine_first_output_ns: '1152921504606846977',
       engine_last_output_ns: '1152921504606847105', engine_first_chunk_tokens: 1},
      '2',
    );
    expect(speed.endToEnd).toBeCloseTo(2 / 128e-9, 3);
    expect(speed.decode).toBeCloseTo(1 / 128e-9, 3);
  });

  it('returns null for each value whose inputs are unknown', () => {
    expect(computeSpeed(emptyTiming, '100')).toEqual({endToEnd: null, decode: null});
    expect(
      computeSpeed({...emptyTiming, engine_received_ns: '1', engine_last_output_ns: '1000000001'}, '100'),
    ).toEqual({endToEnd: 100, decode: null});
  });

  it('returns null when a denominator is zero or negative, never Infinity', () => {
    const same = {...emptyTiming, engine_received_ns: '5', engine_first_output_ns: '5', engine_last_output_ns: '5', engine_first_chunk_tokens: 1};
    expect(computeSpeed(same, '10')).toEqual({endToEnd: null, decode: null});
    const backwards = {...same, engine_received_ns: '9', engine_first_output_ns: '9'};
    expect(computeSpeed(backwards, '10')).toEqual({endToEnd: null, decode: null});
  });

  it('does not report a measured zero', () => {
    const timing = {...emptyTiming, engine_received_ns: '0', engine_first_output_ns: '1', engine_last_output_ns: '1000000001', engine_first_chunk_tokens: 32};
    expect(computeSpeed(timing, '0').endToEnd).toBeNull();
    expect(computeSpeed(timing, '32').decode).toBeNull();
    expect(computeSpeed(timing, '20').decode).toBeNull();
  });
});

describe('formatSpeed', () => {
  it('shows the value with its unit', () => {
    expect(formatSpeed(12.345)).toBe('12.3 tok/s');
  });
  it('shows "Not available" for missing data', () => {
    expect(formatSpeed(null)).toBe('Not available');
  });
});
