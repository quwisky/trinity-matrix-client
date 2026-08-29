import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const serviceFile =
  'libs/data-access/auth/src/lib/session-establishment.service.ts';

/**
 * Freeze the temporary authentication compatibility facade while Account Runtime lands.
 *
 * ADR 0007 requires every compatibility facade to have a caller allowlist, a counter,
 * parity coverage, and a named removal owner. Without this source-shape guard, new auth
 * flows could quietly couple themselves to SessionEstablishmentService and turn the
 * migration seam into permanent architecture. GitHub issue #303 owns its removal.
 */
describe('Account Runtime authentication facade', () => {
  const productionCallers = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
  })
    .filter(
      (file) =>
        !file.endsWith('.spec.ts') &&
        file !== serviceFile &&
        readFileSync(join(workspaceRoot, file), 'utf8').includes(
          'SessionEstablishmentService',
        ),
    )
    .sort();

  it('has exactly the two frozen production callers', () => {
    expect(productionCallers).toEqual([
      'libs/data-access/auth/src/lib/auth.service.ts',
      'libs/data-access/auth/src/lib/registration.service.ts',
    ]);
  });

  it('is not exposed as public API', () => {
    const publicEntrypoint = readFileSync(
      join(workspaceRoot, 'libs/data-access/auth/src/index.ts'),
      'utf8',
    );
    expect(publicEntrypoint).not.toContain('session-establishment.service');
    expect(publicEntrypoint).not.toContain('SessionEstablishmentService');
  });

  it('records the parity suite and removal issue in architecture documentation', () => {
    const architecture = readFileSync(
      join(workspaceRoot, 'docs/architecture/matrix-and-encryption.md'),
      'utf8',
    );
    expect(architecture).toContain('session-establishment.integration.spec.ts');
    expect(architecture).toContain('#303');
  });
});
