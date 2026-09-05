import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ADR-0007: frozen legacy warning seam. Producer migrations shrink this list;
// "Present startup-safe capability status and actionable recovery" removes it:
// https://github.com/quwisky/trinity-matrix-client/issues/455
const legacyFiles = [
  'libs/application/runtime/src/lib/application-root/application-root.component.ts',
  'libs/application/runtime/src/lib/application-runtime.adapter.ts',
  'libs/application/runtime/src/lib/application-runtime.models.ts',
  'libs/application/runtime/src/lib/application-runtime.service.ts',
  'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
  'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
];
const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

describe('capability health expand-migrate-contract ledger', () => {
  it('freezes exactly six legacy warning producers and consumers until removal', () => {
    const actual = globSync(['apps/**/*.ts', 'libs/**/*.ts'], { cwd: root })
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) =>
        /\bApplicationRuntimeWarning\b|\bApplicationWarningScope\b/u.test(
          read(file),
        ),
      )
      .sort();
    expect(actual).toEqual(legacyFiles);
    expect(actual.length).toBe(6);
  });

  it('does not route migrated Identity health back through permanent warnings', () => {
    const session = read(legacyFiles[5]);
    expect(session).not.toContain('identity-presence-unavailable');
    expect(session).not.toContain('IdentityOperationError');
    expect(session.match(/this\.identity\.run\(/gu)).toHaveLength(1);
  });
});
