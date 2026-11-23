// WCAG contrast of the accent colours, read from the theme in index.css (light and dark).
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../index.css'), 'utf8');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark) {');
const blocks = {light: css.slice(0, darkStart), dark: css.slice(darkStart)};

function token(scheme: 'light' | 'dark', name: string): string {
  const own = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(blocks[scheme]);
  const fallback = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(blocks.light);
  const value = (own ?? fallback)?.[1];
  if (!value) throw new Error(`no ${name} for ${scheme}`);
  return value;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (top: number[], bottom: number[], alpha: number) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));
function luminance(c: number[]): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(['light', 'dark'] as const)('%s theme contrast', (scheme) => {
  it('main button text on the accent is at least 4.5:1', () => {
    expect(contrast(rgb(token(scheme, 'primary-foreground')), rgb(token(scheme, 'primary')))).toBeGreaterThanOrEqual(4.5);
  });

  it('the blue pill text on its tint over a card is at least 4.5:1', () => {
    // Pill tone "info": text-info on bg-primary/10, over the card.
    const background = mix(rgb(token(scheme, 'primary')), rgb(token(scheme, 'card')), 0.1);
    expect(contrast(rgb(token(scheme, 'info')), background)).toBeGreaterThanOrEqual(4.5);
  });
});
