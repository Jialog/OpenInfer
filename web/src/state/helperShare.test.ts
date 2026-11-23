import {describe, expect, it} from 'vitest';
import {helperShare} from './helperShare';

const stats = (accepted: string | null) => ({helper_draft_tokens: null, helper_verified_tokens: null, accepted_external_tokens: accepted,
                                              think_end_position: null});

describe('helper share', () => {
  it('says how many output tokens the server took from the helper', () => {
    expect(helperShare(stats('146'), '188')).toBe('The server used 146 tokens written by the helper (of 188, 78%).');
  });

  it('shows nothing when the count is unknown', () => {
    expect(helperShare(stats(null), '188')).toBeNull();
    expect(helperShare(undefined, '188')).toBeNull();
  });

  it('shows a measured zero as zero', () => {
    expect(helperShare(stats('0'), '188')).toBe('The server used 0 tokens written by the helper (of 188, 0%).');
  });

  it('uses one token in the singular, and counts beyond 2^53 exactly', () => {
    expect(helperShare(stats('1'), '3')).toBe('The server used 1 token written by the helper (of 3, 33%).');
    expect(helperShare(stats('9007199254740993'), '9007199254740995')).toBe(
      'The server used 9007199254740993 tokens written by the helper (of 9007199254740995, 100%).');
  });

  it('shows nothing when there is no output', () => {
    expect(helperShare(stats('0'), '0')).toBeNull();
  });
});
