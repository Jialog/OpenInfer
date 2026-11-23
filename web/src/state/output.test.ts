import {describe, expect, it} from 'vitest';
import type {Chunk} from '@/api/types';
import {NOW, makeRequest} from '@/test/factories';
import {applyChunks, emptyOutput, isOutputComplete} from './output';

function chunk(seq: number, text: string, segment: Chunk['segment'] = null, tokens = 1): Chunk {
  return {request_id: 'r', seq: String(seq), text, token_count: tokens, committed_position: '0', segment,
          engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null, received_at: NOW};
}

describe('applyChunks', () => {
  it('appends in sequence order', () => {
    const out = applyChunks(emptyOutput, [chunk(1, 'a'), chunk(2, 'b')]);
    expect(out.answer).toBe('ab');
    expect(out.contiguous).toBe(2);
  });

  it('drops duplicates by sequence number', () => {
    let out = applyChunks(emptyOutput, [chunk(1, 'a'), chunk(2, 'b')]);
    out = applyChunks(out, [chunk(1, 'a'), chunk(2, 'b')]);
    expect(out.answer).toBe('ab');
    expect(out.contiguous).toBe(2);
    expect(Object.keys(out.pending)).toHaveLength(0);
  });

  it('holds a chunk after a gap and releases it when the gap is filled', () => {
    let out = applyChunks(emptyOutput, [chunk(1, 'a'), chunk(3, 'c')]);
    expect(out.answer).toBe('a');
    expect(out.contiguous).toBe(1);
    out = applyChunks(out, [chunk(2, 'b')]);
    expect(out.answer).toBe('abc');
    expect(out.contiguous).toBe(3);
    expect(Object.keys(out.pending)).toHaveLength(0);
  });

  it('counts empty-text chunks as present', () => {
    const out = applyChunks(emptyOutput, [chunk(1, ''), chunk(2, 'x')]);
    expect(out.contiguous).toBe(2);
    expect(out.answer).toBe('x');
  });
});

describe('thinking and answer', () => {
  it('keeps the thinking apart from the answer and counts its tokens', () => {
    let out = applyChunks(emptyOutput, [chunk(1, 'Let me ', 'think', 2), chunk(2, 'see.', 'think', 3)]);
    expect(out.think).toBe('Let me see.');
    expect(out.thinkTokens).toBe(5);
    expect(out.answer).toBe('');
    out = applyChunks(out, [chunk(3, 'It is 4.', 'answer', 4)]);
    expect(out.think).toBe('Let me see.');
    expect(out.thinkTokens).toBe(5);
    expect(out.answer).toBe('It is 4.');
  });

  it('puts a chunk recorded before segments existed with the answer, as one text', () => {
    const out = applyChunks(emptyOutput, [chunk(1, '<think>a</think>', null, 6), chunk(2, 'b', null, 1)]);
    expect(out.answer).toBe('<think>a</think>b');
    expect(out.think).toBe('');
    expect(out.thinkTokens).toBe(0);
  });

  it('adds a thinking chunk that fills a gap only once it is in order', () => {
    let out = applyChunks(emptyOutput, [chunk(1, 'a', 'think', 1), chunk(3, 'c', 'answer', 1)]);
    expect(out.answer).toBe('');
    out = applyChunks(out, [chunk(2, 'b', 'think', 2), chunk(2, 'b', 'think', 2)]);
    expect(out.think).toBe('ab');
    expect(out.thinkTokens).toBe(3);
    expect(out.answer).toBe('c');
  });

  // The blank lines the model writes after the thinking are not part of the answer that is
  // shown and copied, also when they arrive in chunks of their own. The thinking keeps its white space.
  it('starts the answer at its first character that is not white space', () => {
    let out = applyChunks(emptyOutput, [chunk(1, '\nHm.\n', 'think'), chunk(2, '\n\n', 'answer')]);
    expect(out.answer).toBe('');
    out = applyChunks(out, [chunk(3, ' \nHello!', 'answer'), chunk(4, '\n\nBye. ', 'answer')]);
    expect(out.answer).toBe('Hello!\n\nBye. ');
    expect(out.think).toBe('\nHm.\n');
  });

  // Only the blank lines go; the first line's indentation is part of the answer, also when it arrives
  // before the line's text. A chunk recorded before segments existed (null) counts as answer, as /v1 counts it.
  it('keeps the indentation of the first answer line and drops only the blank lines before it', () => {
    let out = applyChunks(emptyOutput, [chunk(1, 'Hm.', 'think'), chunk(2, '\n\n  ', 'answer')]);
    expect(out.answer).toBe('');
    out = applyChunks(out, [chunk(3, '  return x\n', 'answer')]);
    expect(out.answer).toBe('    return x\n');
    expect(applyChunks(emptyOutput, [chunk(1, '\n\n    return x\n', 'answer')]).answer).toBe('    return x\n');
    expect(applyChunks(emptyOutput, [chunk(1, '\n  ', 'answer'), chunk(2, ' \nHi', 'answer')]).answer).toBe('Hi');
    expect(applyChunks(emptyOutput, [chunk(1, '\n\n', 'answer'), chunk(2, '  ', 'answer')]).answer).toBe('');
    expect(applyChunks(emptyOutput, [chunk(1, '\n\nold text')]).answer).toBe('old text');
  });
});

describe('isOutputComplete', () => {
  it('is false until the request is terminal', () => {
    const out = applyChunks(emptyOutput, [chunk(1, 'a')]);
    expect(isOutputComplete(makeRequest({state: 'running', contiguous_seq: '1'}), out)).toBe(false);
    expect(isOutputComplete(makeRequest({state: 'recovering', contiguous_seq: '1'}), out)).toBe(false);
  });

  it('is false for a terminal request whose contiguous chunks are not all here', () => {
    const out = applyChunks(emptyOutput, [chunk(1, 'a')]);
    expect(isOutputComplete(makeRequest({state: 'completed', contiguous_seq: '2', final_seq: '2'}), out)).toBe(false);
  });

  it('is true for a terminal request with its contiguous chunks', () => {
    const out = applyChunks(emptyOutput, [chunk(1, 'a'), chunk(2, 'b')]);
    expect(isOutputComplete(makeRequest({state: 'completed', contiguous_seq: '2', final_seq: '2'}), out)).toBe(true);
  });

  it('accepts a failed request that has only a partial prefix', () => {
    const out = applyChunks(emptyOutput, [chunk(1, 'a')]);
    expect(isOutputComplete(makeRequest({state: 'failed', contiguous_seq: '1', final_seq: null}), out)).toBe(true);
    expect(isOutputComplete(makeRequest({state: 'cancelled', contiguous_seq: '0', final_seq: null}), emptyOutput)).toBe(true);
  });
});
