import {describe, expect, it} from 'vitest';
import {splitOutput} from './outputParts';

describe('output parts', () => {
  it('keeps text without fences as one text part', () => {
    expect(splitOutput('Hello\nworld')).toEqual([{kind: 'text', text: 'Hello\nworld'}]);
    expect(splitOutput('')).toEqual([]);
  });

  it('cuts a fenced block out as code with its language', () => {
    expect(splitOutput('Here:\n```python\ndef f():\n    return 1\n```\nDone.')).toEqual([
      {kind: 'text', text: 'Here:'},
      {kind: 'code', language: 'python', text: 'def f():\n    return 1', closed: true},
      {kind: 'text', text: 'Done.'},
    ]);
  });

  it('reads an answer: thinking text, a python block, then a sentence', () => {
    const text = 'One sentence for complexity.\n\n\n```python\ndef fibonacci(n: int) -> int:\n    a, b = 0, 1\n    return a\n```\n\nThe function runs in O(n) time.';
    const parts = splitOutput(text);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'code', 'text']);
    expect(parts[0].text).toBe('One sentence for complexity.\n\n');
    expect(parts[1]).toMatchObject({language: 'python', closed: true, text: 'def fibonacci(n: int) -> int:\n    a, b = 0, 1\n    return a'});
    expect(parts[2].text).toBe('\nThe function runs in O(n) time.');
  });

  it('shows a block that is still streaming as open code', () => {
    expect(splitOutput('Start\n```\nx = 1\ny')).toEqual([
      {kind: 'text', text: 'Start'},
      {kind: 'code', language: null, text: 'x = 1\ny', closed: false},
    ]);
  });

  it('does not treat backticks inside a line as a fence', () => {
    expect(splitOutput('Use ```code``` like this')).toEqual([{kind: 'text', text: 'Use ```code``` like this'}]);
  });

  it('keeps markup as plain text inside and outside blocks', () => {
    const parts = splitOutput('<b>bold</b>\n```html\n<script>alert(1)</script>\n```');
    expect(parts[0]).toEqual({kind: 'text', text: '<b>bold</b>'});
    expect(parts[1]).toMatchObject({kind: 'code', text: '<script>alert(1)</script>'});
  });
});
