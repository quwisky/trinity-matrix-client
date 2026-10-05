import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The global reduced-motion reset removes transitions instead of shortening them (#962).
 *
 * Shortening alone left `transition-property` at its initial `all`, so every element
 * transitioned every property for 0.01ms. A geometry style set from code then kept its
 * old computed value for that frame, and a layout read straight after it was stale —
 * only for reduced-motion users (#959). Turning the property off fixes every such site
 * at once, which only holds while nothing waits for a transition to end.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

describe('global reduced-motion reset', () => {
  it('turns transitions off rather than only shortening them', () => {
    const scss = read('apps/trinity/src/global.scss');
    const block = scss.slice(
      scss.indexOf('@media (prefers-reduced-motion: reduce)'),
    );

    expect(block).toMatch(/transition-property:\s*none\s*!important/);
  });

  it('leaves no app code waiting for a transition that no longer runs', () => {
    const waiting = globSync('{apps,libs}/**/*.ts', { cwd: workspaceRoot })
      .filter(
        (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
      )
      .filter((file) => /transitionend|transitioncancel/i.test(read(file)));

    expect(waiting).toEqual([]);
  });
});
