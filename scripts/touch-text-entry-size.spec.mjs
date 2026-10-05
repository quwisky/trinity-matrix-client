import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * iOS WebKit zooms the page when a focused text field computes below 16px (#974). Every
 * text-entry control therefore resolves to at least 16px on touch devices, while still
 * scaling with the Text size setting (rem-based), so the floor is a `max()` and not a pin.
 */
const read = (file) =>
  readFileSync(join(import.meta.dirname, '..', file), 'utf8');

describe('touch text-entry font size floor', () => {
  it('defines the floor as a 16px theme-foundation token', () => {
    expect(
      read('libs/theme-foundation/styles/internal/variables.scss'),
    ).toMatch(/--trinity-type-entry-min-size:\s*max\(1rem,\s*16px\);/u);
  });

  it('applies max(scaled size, floor) to every text-entry control on coarse pointers', () => {
    const global = read('apps/trinity/src/global.scss');
    // The rule sits inside the touch-target `@media (pointer: coarse)` block.
    expect(global).toMatch(
      /@media \(pointer: coarse\) \{[^@]*\[contenteditable/u,
    );
    const rule = global.match(
      /\[contenteditable[^{]*\{\s*font-size:\s*max\(([^;]*)\);/,
    );
    expect(rule, 'coarse-pointer text-entry font-size rule').not.toBeNull();
    expect(rule[1]).toContain('var(--trinity-type-entry-min-size)');
  });
});
