import {describe, expect, it} from 'vitest';
import {checkedText, findLeak} from './leaks.mjs';

describe('visible-text leak check', () => {
  it.each([
    'Check version setup missing passed.', 'Needs T4 to finish', 'P3 T10 sections 5, 10.1', 'from p3',
    'No longer valid: direction_unreachable. Run the test again.', 'capacity_insufficient',
    'not installed in /opt/openinfer/envs/helper/bin/python', 'sglang: found', 'see /usr/local/bin/python3',
  ])('catches %j', (text) => {
    expect(findLeak(text)).not.toBeNull();
  });

  it.each([
    'UD-Q3_K_XL + draft Q4_K_M, 5 drafts a round (first choice)', 'Linux · x86_64', 'RTX A5000 24.0 GiB',
    'Can be the server (MLX)', 'Needs 15.0 GiB, 22.5 GiB available', 'round trip 0.40 ms · 924 Mbit/s',
    'owner@example.com', 'The server used 146 tokens written by the helper (of 188, 78%).',
  ])('lets %j through', (text) => {
    expect(findLeak(text)).toBeNull();
  });
});

describe('checked text', () => {
  it('leaves out code blocks marked as showing field names on purpose, checks the rest and puts the blocks back', () => {
    document.body.innerHTML = '<main><p>Call the API.</p><pre data-leak-exempt=""><code>max_tokens</code></pre><p>Then wait.</p></main>';
    const root = document.querySelector('main');
    const text = checkedText(root);
    expect(text).toContain('Call the API.');
    expect(text).toContain('Then wait.');
    expect(text).not.toContain('max_tokens');
    expect(findLeak(text)).toBeNull();
    expect(root.textContent).toBe('Call the API.max_tokensThen wait.');
  });

  it('still catches a field name outside a marked block', () => {
    document.body.innerHTML = '<main><p>Set max_tokens.</p><pre data-leak-exempt="">reasoning_content</pre></main>';
    expect(findLeak(checkedText(document.querySelector('main')))).toBe('max_tokens');
  });
});
