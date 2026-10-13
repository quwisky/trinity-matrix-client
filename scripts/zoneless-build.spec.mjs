import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * The renderer runs zoneless, and the build has to know it.
 *
 * `@angular/build` decides whether an application uses zone.js from its `polyfills` option
 * alone: `zone.js`, or ANY file path such as `src/polyfills.ts`, makes it treat the app as
 * zone-based. It then turns esbuild's `async-await` support off and rewrites every `async`
 * function, ours and every dependency's, into generator code so that zone.js could patch it.
 * A comment-only polyfills file kept that rewrite on for a zoneless app (#1296).
 *
 * Mirrors `isZonelessApp()` in `@angular/build/src/tools/esbuild/utils.js`. A browser polyfill
 * still belongs in this list as a package specifier, which keeps native async/await.
 */
const isZonelessApp = (polyfills) =>
  !polyfills?.some((p) => p === 'zone.js' || /\.[mc]?[jt]s$/.test(p));

describe('zoneless renderer build', () => {
  const project = JSON.parse(
    readFileSync(join(workspaceRoot, 'apps/trinity/project.json'), 'utf8'),
  );
  const polyfills = project.targets.build.options.polyfills;

  it('lists no zone.js and no local polyfill file, so async/await stays native', () => {
    expect(isZonelessApp(polyfills)).toBe(true);
  });
});
