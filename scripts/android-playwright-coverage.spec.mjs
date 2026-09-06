import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const webSpecs = globSync('**/*.spec.mts', {
  cwd: join(workspaceRoot, 'e2e/browser/journeys'),
}).sort();
const androidConfig = readFileSync(
  join(workspaceRoot, 'e2e/android/playwright.config.mts'),
  'utf8',
);
const ciWorkflow = readFileSync(
  join(workspaceRoot, '.github/workflows/ci.yml'),
  'utf8',
);
const code = (file) =>
  readFileSync(join(workspaceRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

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
    const runner = code('e2e/android/run.mts');
    expect(runner).toContain("TRINITY_E2E_PLATFORM'] = 'android'");
    expect(runner).toContain('already contains ${driverPackage}');
    expect(runner).not.toContain('preexistingDriverPackages');
  });

  it('installs only the manifest-verified shared renderer', () => {
    const runner = code('e2e/android/run.mts');
    expect(runner).toContain("'scripts/web-bundle-manifest.mjs'");
    expect(runner).toContain("'verify-with-extras'");
    expect(runner).toContain("'android/app/src/main/assets/public'");
    expect(runner).toContain("'cordova_plugins.js'");
  });

  it('pins the long-run renderer and suite-level infrastructure boundary', () => {
    const runner = code('e2e/android/run.mts');
    const fixture = code('e2e/android/fixtures.mts');
    expect(runner).toContain("'-no-snapshot'");
    expect(runner).toContain("'software'");
    expect(runner).toContain("'-Vulkan'");
    expect(runner).not.toContain('swiftshader_indirect');
    expect(runner).toContain('inspectAndroidInfrastructure');
    expect(runner).toContain('ADB_FAILURE_LIMIT');
    expect(runner).toContain('startAndroidInfrastructureWatchdog');
    expect(fixture).toContain("TRINITY_ANDROID_FATAL_MARKER']");
    expect(fixture).toContain('waitForApplicationReadySurface');
    expect(fixture).toContain('stabilizeApplicationSurface');
    expect(fixture).toContain('runApplicationWebViewOperation');
    expect(fixture).toContain('isAndroidWebViewProbeUnavailable');
    expect(fixture).toContain('waitForActivatedApplicationPage');
    expect(fixture).toContain(
      'primary Android app activation after secondary app',
    );
    expect(fixture).toContain('primary Android app authentication callback');
    expect(fixture).toContain('ANDROID_SURFACE_INITIAL_TIMEOUT_MS');
    expect(fixture).toContain('ANDROID_SURFACE_RECOVERY_TIMEOUT_MS');
    expect(fixture).toContain(
      "configureApplicationNavigation(page, 'Android WebView')",
    );
    expect(fixture).toContain("'secondary Android WebView'");
    expect(fixture).toContain('trinityCrashProcessNames(crashLog)');
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
    expect(fixture).toContain('cmd location providers add-test-provider gps');
    expect(fixture).toContain(
      'cmd location providers set-test-provider-location gps',
    );
    expect(fixture).toContain(
      'cmd location providers remove-test-provider gps',
    );
    expect(fixture).not.toMatch(
      /Object\.defineProperty\(navigator,\s*['"]geolocation['"]/,
    );
    expect(fixture).not.toContain('Emulation.setGeolocationOverride');
  });
});
