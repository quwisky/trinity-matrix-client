import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  validateCurrentNativeHosts,
  validateNativeHostContract,
} from './native-host-contract.mjs';

const workspaceRoot = join(import.meta.dirname, '..');

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
                command: 'pnpm exec nx run trinity-e2e-android:e2e',
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
      ':capacitor-status-bar',
    ].join('\n'),
    androidAppBuild: 'implementation "me.leolin:ShortcutBadger:1.1.22@aar"',
    iosPlugins: [
      'AparajitaCapacitorSecureStorage',
      'CapacitorApp',
      'CapacitorBrowser',
      'CapacitorFilesystem',
      'CapacitorLocalNotifications',
      'CapacitorPushNotifications',
      'CapacitorStatusBar',
      'CapawesomeCapacitorBadge',
    ].join('\n'),
    androidManifest: 'android:scheme="eu.qwky.trinity"',
    iosInfo:
      '<key>UIViewControllerBasedStatusBarAppearance</key><true/>' +
      '<key>FirebaseAppDelegateProxyEnabled</key><false/>' +
      '<key>CFBundleURLSchemes</key><string>eu.qwky.trinity</string>',
    iosProject:
      'repositoryURL = "https://github.com/firebase/firebase-ios-sdk.git";' +
      'kind = exactVersion; version = 12.13.0;' +
      'productName = FirebaseCore; productName = FirebaseMessaging;' +
      'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;'.repeat(2) +
      'fileRef = B60600000000000000000021;' +
      'path = ../en.lproj/Localizable.strings;' +
      'B60600000000000000000003;' +
      'path = ../../PushRegistration/Sources/PushRegistration/TrinityPushTokenCoordinator.swift;' +
      'fileRef = B60600000000000000000024; B60600000000000000000006,',
    iosEntitlements:
      '<key>aps-environment</key><string>$(APS_ENVIRONMENT)</string>',
    iosViewController:
      'registerPluginInstance(TrinityPushRegistrationPlugin())',
    iosRegistration:
      'Messaging.messaging().apnsToken = deviceToken; object: token',
    iosRegistrationPlugin:
      'let jsName = "TrinityPushRegistration"; setAPNsToken(deviceToken)',
    iosAppDelegate: '',
    iosCoordinator: 'import Foundation',
    iosPushPackage:
      'name: "PushRegistration"; .target(name: "PushRegistration")',
    iosStrings:
      '"TRINITY_NOTIFICATION_TITLE" = "Trinity";"TRINITY_NEW_MESSAGE" = "New message";',
    iosCopyScript:
      'if [ -s "${source_file}" ]; then cp "${source_file}" "${destination}"; else rm -f "${destination}"; fi',
  };
}

describe('native host contract', () => {
  it('preserves the APNs badge until Matrix reconciliation in the effective Capacitor configuration', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "require('@capacitor/cli/dist/config').loadConfig().then(({ app }) => process.stdout.write(JSON.stringify(app.extConfig.plugins.Badge)))",
      ],
      { cwd: workspaceRoot, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      persist: false,
      autoClear: false,
    });
  });

  it('accepts the baseline used by mutation tests', () => {
    const errors = [];
    validateNativeHostContract(validInput(), errors);
    expect(errors).toEqual([]);
  });

  it('rejects competing Android badge owners', () => {
    const input = validInput();
    input.androidPlugins += '\n:capawesome-capacitor-badge';
    const errors = [];
    validateNativeHostContract(input, errors);
    expect(errors).toContain(
      'Android badge writes must have only the Trinity native owner',
    );
  });

  it('rejects a missing native badge dependency', () => {
    const input = validInput();
    input.androidAppBuild =
      '// implementation "me.leolin:ShortcutBadger:1.1.22@aar"';
    const errors = [];
    validateNativeHostContract(input, errors);
    expect(errors).toContain(
      'Android badge owner requires the pinned ShortcutBadger adapter',
    );
  });

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
      'Android status-bar plugin',
      'androidPlugins',
      ':capacitor-status-bar',
      '// :capacitor-status-bar',
      'Android host is missing plugin wiring: :capacitor-status-bar',
    ],
    [
      'iOS status-bar plugin',
      'iosPlugins',
      'CapacitorStatusBar',
      '// CapacitorStatusBar',
      'iOS host is missing plugin wiring: CapacitorStatusBar',
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
    [
      'iOS status-bar ownership',
      'iosInfo',
      '<key>UIViewControllerBasedStatusBarAppearance</key><true/>',
      '<!-- <key>UIViewControllerBasedStatusBarAppearance</key><true/> -->',
      'iOS host must delegate status-bar appearance to its view controller',
    ],
    [
      'iOS Firebase proxy setting',
      'iosInfo',
      '<key>FirebaseAppDelegateProxyEnabled</key><false/>',
      '<key>FirebaseAppDelegateProxyEnabled</key><true/>',
      'iOS Firebase App Delegate proxy must be disabled',
    ],
    [
      'iOS APNs entitlement',
      'iosEntitlements',
      '<key>aps-environment</key>',
      '<key>other</key>',
      'iOS Debug and Release builds must include the APNs entitlement',
    ],
    [
      'iOS push bridge registration',
      'iosViewController',
      'registerPluginInstance(TrinityPushRegistrationPlugin())',
      '// registerPluginInstance(TrinityPushRegistrationPlugin())',
      'iOS host must register the Trinity push bridge',
    ],
    [
      'iOS FCM callback provenance',
      'iosRegistration',
      'object: token',
      'object: deviceToken',
      'iOS push bridge must forward only FCM String tokens',
    ],
    [
      'iOS Firebase product pin',
      'iosProject',
      'version = 12.13.0;',
      'version = 12.12.0;',
      'iOS host must pin FirebaseCore and FirebaseMessaging to 12.13.0',
    ],
    [
      'iOS localized push key',
      'iosStrings',
      'TRINITY_NEW_MESSAGE',
      'TRINITY_OLD_MESSAGE',
      'iOS host must bundle the native push localization keys',
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

  it('copies an optional Firebase config when present', () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-ios-copy-'));
    const sourceDir = join(root, 'App');
    const outputDir = join(root, 'Build', 'Resources');
    const source = join(sourceDir, 'GoogleService-Info.plist');
    const destination = join(outputDir, 'GoogleService-Info.plist');
    spawnSync('mkdir', ['-p', sourceDir, outputDir]);
    writeFileSync(source, 'test-config');

    const result = spawnSync(
      'sh',
      ['ios/App/App/copy-google-service-info.sh'],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          SRCROOT: root,
          TARGET_BUILD_DIR: join(root, 'Build'),
          UNLOCALIZED_RESOURCES_FOLDER_PATH: 'Resources',
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('test-config');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'copy script removes stale Firebase config when source is %s',
    (_label, content) => {
      const root = mkdtempSync(join(tmpdir(), 'trinity-ios-copy-'));
      const sourceDir = join(root, 'App');
      const outputDir = join(root, 'Build', 'Resources');
      const source = join(sourceDir, 'GoogleService-Info.plist');
      const destination = join(outputDir, 'GoogleService-Info.plist');
      const mkdir = spawnSync('mkdir', ['-p', sourceDir, outputDir]);
      expect(mkdir.status).toBe(0);
      writeFileSync(destination, 'stale');
      if (content !== undefined) writeFileSync(source, content);

      const result = spawnSync(
        'sh',
        ['ios/App/App/copy-google-service-info.sh'],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            SRCROOT: root,
            TARGET_BUILD_DIR: join(root, 'Build'),
            UNLOCALIZED_RESOURCES_FOLDER_PATH: 'Resources',
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      // The script's destination is removed for both absent and zero-byte sources.
      expect(existsSync(destination)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    },
  );
});
