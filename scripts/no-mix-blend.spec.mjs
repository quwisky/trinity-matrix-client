import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `mix-blend-mode` forces a composited layer and a render surface for every element that
 * carries it. On the avatar ring that was ~46 layers in a timeline, about 165 MB of GPU
 * memory on macOS at rest. Edges that should read against any background use a
 * translucent colour (`border-foreground/10`) instead.
 */

const workspaceRoot = join(import.meta.dirname, '..');

describe('no mix-blend-mode in app source', () => {
  it('keeps blend modes out of libs, apps and electron', () => {
    const files = globSync(['{libs,apps,electron}/**/*.{ts,html,scss,css}'], {
      cwd: workspaceRoot,
      exclude: (f) => f.includes('node_modules'),
    }).filter((file) => !file.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((file) =>
      /mix-blend/u.test(readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
