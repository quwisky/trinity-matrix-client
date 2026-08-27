import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const webSpecs = globSync('*.spec.mts', {
  cwd: join(workspaceRoot, 'e2e/playwright'),
}).sort();
const androidConfig = readFileSync(
  join(workspaceRoot, 'e2e/playwright.android.config.mts'),
  'utf8',
);
const ciWorkflow = readFileSync(
  join(workspaceRoot, '.github/workflows/ci.yml'),
  'utf8',
);

describe('Android Playwright canonical coverage', () => {
  it('routes every web spec through the platform fixture', () => {
    const bypasses = webSpecs.filter((spec) => {
      const source = readFileSync(
        join(workspaceRoot, 'e2e/playwright', spec),
        'utf8',
      );
      return !source.includes("from './support/fixtures.mts'");
    });
    expect(bypasses).toEqual([]);
  });

  it('collects all canonical web specs and the Android-only lifecycle specs', () => {
    expect(androidConfig).toContain("'playwright/**/*.spec.mts'");
    expect(androidConfig).toContain("'android/**/*.spec.mts'");
  });

  it('keeps the platform selector inside the Android runner', () => {
    const runner = readFileSync(
      join(workspaceRoot, 'e2e/android/run.mts'),
      'utf8',
    );
    expect(runner).toContain("TRINITY_E2E_PLATFORM'] = 'android'");
  });

  it('fails CI shards when any Android retry is flaky', () => {
    expect(ciWorkflow).toContain(
      'pnpm e2e:android -- --fail-on-flaky-tests --shard=',
    );
  });

  it('does not replace unavailable native behavior with renderer-only passes', () => {
    const fixture = readFileSync(
      join(workspaceRoot, 'e2e/android/fixtures.mts'),
      'utf8',
    );
    expect(fixture).not.toContain('element.scrollTop +=');

    const explicitSkips = [
      ['key-export.spec.mts', 'native WebView export needs'],
      ['notifications.spec.mts', 'native notification delivery needs'],
      [
        'multi-account.spec.mts',
        'native notification delivery and collapse tags need',
      ],
      ['message-swipe.spec.mts', 'does not expose compositor touch panning'],
    ];
    for (const [spec, reason] of explicitSkips) {
      const source = readFileSync(
        join(workspaceRoot, 'e2e/playwright', spec),
        'utf8',
      );
      expect(source).toContain(reason);
    }
  });
});
