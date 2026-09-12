import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
/**
 * Pin retirement of the temporary authentication compatibility facade.
 *
 * ADR 0007 requires every compatibility facade to have a caller allowlist, a counter,
 * parity coverage, and a named removal owner. Without this source-shape guard, new auth
 * New authentication flows must issue opaque grants directly to Account Runtime.
 */
describe('Account Runtime authentication facade', () => {
  const productionCallers = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
  })
    .filter(
      (file) =>
        !file.endsWith('.spec.ts') &&
        readFileSync(join(workspaceRoot, file), 'utf8').includes(
          'SessionEstablishmentService',
        ),
    )
    .sort();

  it('has no production callers', () => {
    expect(productionCallers).toEqual([]);
  });

  it('is not exposed as public API', () => {
    const publicEntrypoint = readFileSync(
      join(workspaceRoot, 'libs/data-access/auth/src/index.ts'),
      'utf8',
    );
    expect(publicEntrypoint).not.toContain('session-establishment.service');
    expect(publicEntrypoint).not.toContain('SessionEstablishmentService');
    expect(
      globSync(
        'libs/data-access/auth/src/lib/session-establishment.service.ts',
        {
          cwd: workspaceRoot,
        },
      ),
    ).toEqual([]);
  });

  it('records the parity suite and removal issue in architecture documentation', () => {
    const architecture = readFileSync(
      join(
        workspaceRoot,
        'apps/docs-developers/src/content/docs/architecture/matrix-integration.md',
      ),
      'utf8',
    );
    expect(architecture).toContain('AccountRuntimeService');
    expect(architecture).not.toContain('temporary compatibility facade');
  });
});
