import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ADR-0007: frozen legacy warning seam. Producer migrations shrink this list;
// "Present startup-safe capability status and actionable recovery" removes it:
// https://github.com/quwisky/trinity-matrix-client/issues/455
const legacyFiles = [
  'libs/application/runtime/src/lib/application-root/application-root.component.ts',
  'libs/application/runtime/src/lib/application-runtime.models.ts',
  'libs/application/runtime/src/lib/application-runtime.service.ts',
  'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
  'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
];
const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const containsWarningCall = (source, code) =>
  new RegExp(`\\bwarning\\([^)]*['"]${code}['"]`, 'u').test(source);

describe('capability health expand-migrate-contract ledger', () => {
  it('freezes exactly five legacy warning producers and consumers until removal', () => {
    const actual = globSync(['apps/**/*.ts', 'libs/**/*.ts'], { cwd: root })
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) =>
        /\bApplicationRuntimeWarning\b|\bApplicationWarningScope\b/u.test(
          read(file),
        ),
      )
      .sort();
    expect(actual).toEqual(legacyFiles);
    expect(actual.length).toBe(5);
  });

  it('does not route migrated Identity health back through permanent warnings', () => {
    const session = read(legacyFiles[4]);
    expect(session).not.toContain('identity-presence-unavailable');
    expect(session).not.toContain('IdentityOperationError');
    expect(session.match(/this\.identity\.run\(/gu)).toHaveLength(1);
  });

  it('does not route migrated Trust health back through permanent warnings', () => {
    const session = read(legacyFiles[4]);
    expect(session).not.toContain('trust-projection-unavailable');
    expect(session).not.toContain('TrustOperationError');
    expect(session.match(/this\.trust\.run\(/gu)).toHaveLength(1);
    expect(session).toContain('this.trust.recover(');
  });

  it('keeps migrated preference and room-order failures out of warnings', () => {
    const runtimeAdapter = read(
      'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
    );
    const sessionAdapter = read(
      'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
    );

    expect(runtimeAdapter).not.toContain('appearance-effects-unavailable');
    expect(runtimeAdapter).not.toContain('room-order-hydration-failed');
    expect(sessionAdapter).not.toContain('room-order-hydration-failed');
  });

  it('keeps migrated notification and Host outcomes out of permanent warnings', () => {
    const runtimeAdapter = read(
      'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
    );
    const sessionAdapter = read(
      'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
    );

    for (const code of [
      'room-notification-projection-unavailable',
      'notification-navigation-rejected',
      'notification-navigation-failed',
      'notification-presentation-failed',
      'push-session-failed',
      'badge-update-failed',
      'update-check-failed',
    ]) {
      expect(containsWarningCall(`warning('workspace', '${code}')`, code)).toBe(
        true,
      );
      for (const source of [sessionAdapter, runtimeAdapter]) {
        expect(containsWarningCall(source, code)).toBe(false);
      }
    }
    expect(runtimeAdapter).not.toContain(
      "warning('session-capabilities', 'badge'",
    );
  });

  it('keeps required startup producers out of warning compatibility', () => {
    const policy = read(
      'libs/application/runtime/src/lib/application-startup.policy.ts',
    );
    const runtimeAdapter = read(
      'libs/application/runtime/src/lib/composition/trinity-application-runtime.adapter.ts',
    );

    expect(policy).toContain(
      'export const REQUIRED_STARTUP_PRODUCER_COMPATIBILITY = [] as const',
    );
    expect(runtimeAdapter).not.toContain('inactive-account-restore-failed');
  });
});
