import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

describe('System Status contract', () => {
  it('keeps the append-only warning channel and its compatibility ledger deleted', () => {
    const source = globSync(['apps/**/*.{ts,html}', 'libs/**/*.{ts,html}'], {
      cwd: root,
    })
      .map(read)
      .join('\n');
    expect(source).not.toMatch(
      /\bApplicationRuntimeWarning\b|\bApplicationWarningScope\b/u,
    );
    expect(source).not.toContain("kind: 'warning'");
    expect(source).not.toContain('REQUIRED_STARTUP_PRODUCER_COMPATIBILITY');
  });

  it('pins safe diagnostics, view-only Account identity and the generic copy fallback', () => {
    const health = read(
      'libs/application/runtime/src/lib/capability-health.service.ts',
    );
    const status = read(
      'libs/application/runtime/src/lib/capability-status.service.ts',
    );
    const catalog = read(
      'libs/application/runtime/src/lib/capability-status.catalog.ts',
    );

    expect(health).toContain('presentationScopes');
    expect(health).not.toMatch(/diagnostics\([\s\S]*accountId/u);
    expect(status).toContain('AccountIdentitiesService');
    expect(catalog).toContain('UNKNOWN_COPY');
  });
});
