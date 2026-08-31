import { describe, expect, it } from 'vitest';
import {
  validateCurrentNativeHosts,
  validateNativeHostContract,
} from './native-host-contract.mjs';

function project(platform) {
  const name = `trinity-${platform}`;
  const isAndroid = platform === 'android';
  return {
    name,
    projectType: 'application',
    tags: ['type:app', 'scope:matrix', 'role:app', 'capability:composition'],
    implicitDependencies: ['trinity'],
    targets: {
      sync: {
        cache: false,
        dependsOn: [{ projects: ['trinity'], target: 'build' }],
        options: { command: `pnpm exec cap sync ${platform}` },
      },
      build: {
        cache: false,
        dependsOn: ['sync'],
        options: {
          command: isAndroid
            ? './gradlew assembleDebug'
            : 'pnpm exec cap build ios --scheme App',
        },
      },
      run: {
        cache: false,
        dependsOn: ['sync'],
        options: { command: `pnpm exec cap run ${platform}` },
      },
      open: {
        cache: false,
        options: { command: `pnpm exec cap open ${platform}` },
      },
      verify: {
        options: {
          command: `node scripts/native-host-contract.mjs ${platform}`,
        },
      },
      'verify-native': {
        cache: false,
        dependsOn: ['sync'],
        options: {
          command: isAndroid
            ? './gradlew testDebugUnitTest'
            : 'xcodebuild -project App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO',
        },
      },
      ...(isAndroid
        ? {
            e2e: {
              cache: false,
              parallelism: false,
              options: {
                command: 'pnpm exec nx run trinity-e2e:android-e2e',
              },
            },
          }
        : {}),
    },
  };
}

function validInput() {
  return {
    projects: { android: project('android'), ios: project('ios') },
    packageJson: {
      scripts: {
        'e2e:android': 'nx run trinity-e2e:e2e-android',
        'android:sync': 'nx run trinity-android:sync',
        'android:run': 'nx run trinity-android:run',
        'android:build': 'nx run trinity-android:build',
        'android:verify': 'nx run trinity-android:verify',
        'ios:sync': 'nx run trinity-ios:sync',
        'ios:run': 'nx run trinity-ios:run',
        'ios:build': 'nx run trinity-ios:build',
        'ios:verify': 'nx run trinity-ios:verify',
      },
    },
    capacitor: "webDir: 'www'",
    capabilityAdapter: [
      'capacitorSupportedOperations(',
      "platform === 'android' ? (['back'] as const) : []",
      'Capacitor.getPlatform(),',
    ].join('\n'),
    operationAdapter: [
      "Capacitor.getPlatform() === 'android'",
      "Capacitor.getPlatform() === 'android'",
      "Capacitor.getPlatform() === 'android'",
    ].join('\n'),
    androidPlugins: [
      ':aparajita-capacitor-secure-storage',
      ':capacitor-app',
      ':capacitor-browser',
      ':capacitor-filesystem',
      ':capacitor-local-notifications',
      ':capacitor-push-notifications',
      ':capawesome-capacitor-badge',
    ].join('\n'),
    iosPlugins: [
      'AparajitaCapacitorSecureStorage',
      'CapacitorApp',
      'CapacitorBrowser',
      'CapacitorFilesystem',
      'CapacitorLocalNotifications',
      'CapacitorPushNotifications',
      'CapawesomeCapacitorBadge',
    ].join('\n'),
    androidManifest: 'android:scheme="eu.qwky.trinity"',
    iosInfo: '<key>CFBundleURLSchemes</key><string>eu.qwky.trinity</string>',
  };
}

describe('native host contract', () => {
  it('validates the checked-in Android and iOS hosts', () => {
    expect(validateCurrentNativeHosts).not.toThrow();
  });

  it('rejects a native lifecycle hidden outside Nx', () => {
    const input = validInput();
    input.projects.android.targets.run = undefined;
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors).toContain(
      'android run must launch the synchronized native host',
    );
  });

  it('rejects a host that no longer builds the shared renderer before sync', () => {
    const input = validInput();
    input.projects.ios.targets.sync.dependsOn = [];
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors).toContain(
      'ios sync must build and copy the shared production renderer',
    );
  });

  it('rejects platform capability drift', () => {
    const input = validInput();
    input.capabilityAdapter = input.capabilityAdapter.replace(
      "platform === 'android' ? (['back'] as const) : []",
      "// platform === 'android' ? (['back'] as const) : []",
    );
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors).toContain(
      'Capacitor capability manifest is missing: platform ===',
    );
  });

  it.each([
    [
      'an empty native verification command',
      (input) => {
        input.projects.ios.targets['verify-native'].options.command = 'true';
      },
      'ios must expose static and toolchain-backed verification targets',
    ],
    [
      'a cached Android installed-app journey',
      (input) => {
        input.projects.android.targets.e2e.cache = true;
      },
      'android e2e must delegate to the uncached serialized installed-app journey',
    ],
    [
      'a parallel Android installed-app journey',
      (input) => {
        input.projects.android.targets.e2e.parallelism = true;
      },
      'android e2e must delegate to the uncached serialized installed-app journey',
    ],
  ])('rejects %s', (_label, mutate, expected) => {
    const input = validInput();
    mutate(input);
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors).toContain(expected);
  });

  it.each([
    [
      'Android plugin',
      'androidPlugins',
      ':capacitor-app',
      '// :capacitor-app',
      'Android host is missing plugin wiring: :capacitor-app',
    ],
    [
      'iOS plugin',
      'iosPlugins',
      'CapacitorApp',
      '// CapacitorApp',
      'iOS host is missing plugin wiring: CapacitorApp',
    ],
    [
      'Android deep link',
      'androidManifest',
      'android:scheme="eu.qwky.trinity"',
      '<!-- android:scheme="eu.qwky.trinity" -->',
      'Android host is missing the authentication deep-link scheme',
    ],
    [
      'iOS deep link',
      'iosInfo',
      '<key>CFBundleURLSchemes</key>',
      '<!-- <key>CFBundleURLSchemes</key> -->',
      'iOS host is missing the authentication deep-link scheme',
    ],
  ])(
    'rejects commented-out %s wiring',
    (_label, field, active, comment, expected) => {
      const input = validInput();
      input[field] = input[field].replace(active, comment);
      const errors = [];

      validateNativeHostContract(input, errors);

      expect(errors).toContain(expected);
    },
  );
});
