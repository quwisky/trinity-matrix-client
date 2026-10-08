import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * global.scss lays out a routed page through the `.trn-routed-page` class, which
 * `markRoutedPage(outlet)` adds on `(activate)`. An outlet that forgets the call renders its
 * pages without that layout and nothing else fails, so every outlet is checked here.
 */

const workspaceRoot = join(import.meta.dirname, '..');

describe('routed page outlets', () => {
  it('marks the page of every router outlet', () => {
    // Outlets live in component templates; no inline template declares one.
    const files = globSync(['libs/**/*.html', 'apps/**/*.html'], {
      cwd: workspaceRoot,
    });
    const outlets = files.flatMap((file) =>
      [
        ...readFileSync(join(workspaceRoot, file), 'utf8').matchAll(
          /<router-outlet\b[^>]*>/gu,
        ),
      ].map(([tag]) => ({ file, tag })),
    );
    // An empty scan would pass vacuously.
    expect(outlets.length).toBeGreaterThan(0);

    expect(
      outlets
        .filter(({ tag }) => !/\bmarkRoutedPage\(/u.test(tag))
        .map(({ file }) => file),
    ).toEqual([]);
  });
});
