import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const webSpecs = globSync('**/*.spec.mts', {
  cwd: join(workspaceRoot, 'e2e/browser/journeys'),
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
        join(workspaceRoot, 'e2e/browser/journeys', spec),
        'utf8',
      );
      return !source.includes("from '../../../fixtures.mts'");
    });
    expect(bypasses).toEqual([]);
  });

  it('collects all canonical web specs and the Android-only lifecycle specs', () => {
    expect(androidConfig).toContain("'browser/journeys/**/*.spec.mts'");
    expect(androidConfig).toContain("'android/**/*.spec.mts'");
  });

  it('keeps the platform selector inside the Android runner', () => {
    const runner = readFileSync(
      join(workspaceRoot, 'e2e/android/run.mts'),
      'utf8',
    );
    expect(runner).toContain("TRINITY_E2E_PLATFORM'] = 'android'");
    expect(runner).toContain('already contains ${driverPackage}');
    expect(runner).not.toContain('preexistingDriverPackages');
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
    const touchAdapter = fixture.slice(
      fixture.indexOf('\n  touchPlatform: async'),
      fixture.indexOf('\n  secondaryApp: async'),
    );
    expect(touchAdapter).toContain(
      "throw new Error(\n          'Android compositor touch panning is unavailable",
    );

    const explicitSkips = [
      [
        'trust/key-export.spec.mts',
        'exports room keys to a file and imports them back',
        'native WebView export needs',
      ],
      [
        'notifications/notifications.spec.mts',
        'notifies for a live message in a room you are not viewing',
        'native notification delivery needs',
      ],
      [
        'accounts/account-notification-routing.spec.mts',
        'raises a notification for a live message to a background account',
        'native notification delivery and collapse tags need',
      ],
      [
        'conversations/message-swipe.spec.mts',
        'a vertical drag still scrolls the timeline',
        'does not expose compositor touch panning',
      ],
    ];
    for (const [spec, title, reason] of explicitSkips) {
      const source = readFileSync(
        join(workspaceRoot, 'e2e/browser/journeys', spec),
        'utf8',
      );
      const titleAt = source.indexOf(title);
      const nextTestAt = source.indexOf('\n  test(', titleAt + title.length);
      const block = source.slice(
        source.lastIndexOf('test(', titleAt),
        nextTestAt === -1 ? source.length : nextTestAt,
      );
      expect(block).toContain(reason);
      expect(block).toMatch(/test\.skip\(\s*isAndroidE2E,\s*['"]/);
    }
  });

  it('drives native location without replacing the browser API', () => {
    const fixture = readFileSync(
      join(workspaceRoot, 'e2e/android/fixtures.mts'),
      'utf8',
    );
    expect(fixture).toContain("'emu',\n      'geo',\n      'fix'");
    expect(fixture).not.toMatch(
      /Object\.defineProperty\(navigator,\s*['"]geolocation['"]/,
    );
    expect(fixture).not.toContain('Emulation.setGeolocationOverride');
  });
});
