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
                command: 'pnpm exec nx run trinity-e2e-mobile:e2e',
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
        'e2e:mobile': 'nx run trinity-e2e:e2e-mobile',
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
    capacitor: [
      "webDir: 'www',",
      "loggingBehavior: process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'debug' : 'none',",
    ].join('\n'),
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
      ':capawesome-capacitor-badge',
      ':trinity-capacitor-push',
    ].join('\n'),
    iosPlugins: [
      'AparajitaCapacitorSecureStorage',
      'CapacitorApp',
      'CapacitorBrowser',
      'CapacitorFilesystem',
      'CapacitorLocalNotifications',
      'CapacitorPushNotifications',
      'CapacitorStatusBar',
      'CapawesomeCapacitorBadge',
      'TrinityCapacitorPush',
    ].join('\n'),
    androidManifest: [
      'android:scheme="dev.trinityproject.trinity"',
      '<service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService"',
      '  tools:node="remove" />',
    ].join('\n'),
    iosInfo:
      '<key>UIViewControllerBasedStatusBarAppearance</key><true/>' +
      '<key>CFBundleURLSchemes</key><string>dev.trinityproject.trinity</string>' +
      '<key>UIApplicationSceneManifest</key><dict>' +
      '<key>UISceneDelegateClassName</key>' +
      '<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string></dict>',
    androidHostActivity: [
      'registerPlugin(AppSettingsPlugin.class);',
      'super.onCreate(savedInstanceState);',
    ].join('\n'),
    iosHostController: 'bridge?.registerPluginInstance(AppSettingsPlugin())',
    androidPushPlugin: [
      '@CapacitorPlugin(name = "PushHandoff")',
      'public class PushHandoffPlugin extends Plugin {',
    ].join('\n'),
    iosPushPlugin: [
      '/** Writes the push handoff store. */',
      '@objc(PushHandoffPlugin)',
      'public class PushHandoffPlugin: CAPPlugin, CAPBridgedPlugin {',
      '    public let jsName = "PushHandoff"',
    ].join('\n'),
    androidPushAppearance: [
      '<drawable name="trinity_push_small_icon">@drawable/ic_stat_trinity</drawable>',
      '<color name="trinity_push_color">@color/ic_launcher_background</color>',
    ].join('\n'),
  };
}

describe('native host contract', () => {
  it('validates the checked-in Android and iOS hosts', () => {
    expect(validateCurrentNativeHosts).not.toThrow();
  });

  it('rejects Capacitor logging that is on by default', () => {
    // The bridge logs plugin arguments (Android) and results (iOS), tokens included.
    const optIn =
      "loggingBehavior: process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'debug' : 'none',";
    for (const capacitor of [
      "webDir: 'www'",
      "webDir: 'www',\nloggingBehavior: 'debug',",
      "webDir: 'www',\nloggingBehavior: 'production',",
      // Only a comment names the safe value.
      "webDir: 'www',\n// loggingBehavior: 'none',\nloggingBehavior: 'debug',",
      // The opt-in inverted: logs unless the variable is set.
      "webDir: 'www',\nloggingBehavior: process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'none' : 'debug',",
      // A platform override wins over the top-level value.
      `webDir: 'www',\n${optIn}\nandroid: { loggingBehavior: 'debug' },`,
    ]) {
      const input = validInput();
      input.capacitor = capacitor;
      const errors = [];

      validateNativeHostContract(input, errors);

      expect(errors, capacitor).toContain(
        'Capacitor logging must default to none: the bridge logs plugin arguments and results',
      );
    }
  });

  it('accepts Capacitor logging that is off unless a local build opts in', () => {
    for (const capacitor of [
      "webDir: 'www',\nloggingBehavior: 'none',",
      [
        "webDir: 'www',",
        '// Off in every build; TRINITY_CAPACITOR_LOGS=1 opts a local build in.',
        'loggingBehavior:',
        "  process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'debug' : 'none',",
      ].join('\n'),
    ]) {
      const input = validInput();
      input.capacitor = capacitor;
      const errors = [];

      validateNativeHostContract(input, errors);

      expect(errors, capacitor).toEqual([]);
    }
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
      'android:scheme="dev.trinityproject.trinity"',
      '<!-- android:scheme="dev.trinityproject.trinity" -->',
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
      'capacitor-push Android module',
      'androidPlugins',
      ':trinity-capacitor-push',
      '// :trinity-capacitor-push',
      'Android host is missing plugin wiring: :trinity-capacitor-push',
    ],
    [
      'capacitor-push Swift package',
      'iosPlugins',
      'TrinityCapacitorPush',
      '// TrinityCapacitorPush',
      'iOS host is missing plugin wiring: TrinityCapacitorPush',
    ],
    [
      'iOS scene lifecycle',
      'iosInfo',
      '<key>UIApplicationSceneManifest</key>',
      '<!-- <key>UIApplicationSceneManifest</key> -->',
      'iOS host must adopt the UIScene lifecycle',
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

  it.each([
    [
      'an Android hand registration of the push plugin',
      (input) => {
        input.androidHostActivity +=
          '\nregisterPlugin(PushHandoffPlugin.class);';
      },
      'Android host must not register PushHandoffPlugin by hand',
    ],
    [
      'an iOS hand registration of the push plugin',
      (input) => {
        input.iosHostController +=
          '\nbridge?.registerPluginInstance(PushHandoffPlugin())';
      },
      'iOS host must not register PushHandoffPlugin by hand',
    ],
    [
      'an iOS instance plugin, which automatic registration skips',
      (input) => {
        input.iosPushPlugin = input.iosPushPlugin.replace(
          'CAPPlugin, CAPBridgedPlugin',
          'CAPInstancePlugin, CAPBridgedPlugin',
        );
      },
      'iOS PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'an iOS file whose first @objc name is another class',
      (input) => {
        input.iosPushPlugin = `@objc(PushRenderHelper)\n${input.iosPushPlugin}`;
      },
      'iOS PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'a renamed iOS plugin',
      (input) => {
        input.iosPushPlugin = input.iosPushPlugin.replace(
          'jsName = "PushHandoff"',
          'jsName = "Handoff"',
        );
      },
      'iOS PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'a renamed Android plugin',
      (input) => {
        input.androidPushPlugin = input.androidPushPlugin.replace(
          '"PushHandoff"',
          '"Handoff"',
        );
      },
      'Android PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'a missing removal of the push plugin service',
      (input) => {
        input.androidManifest = 'android:scheme="dev.trinityproject.trinity"';
      },
      'Android host must remove the push plugin MessagingService from the app manifest',
    ],
    [
      'a commented-out removal of the push plugin service',
      (input) => {
        input.androidManifest = `<!-- ${input.androidManifest} -->`;
      },
      'Android host must remove the push plugin MessagingService from the app manifest',
    ],
    [
      'unbranded Android push notifications',
      (input) => {
        input.androidPushAppearance =
          '<!-- <drawable name="trinity_push_small_icon">@drawable/ic_stat_trinity</drawable> -->';
      },
      'Android host must brand device-rendered push notifications',
    ],
  ])('rejects %s', (_label, mutate, expected) => {
    const input = validInput();
    mutate(input);
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors).toContain(expected);
  });
});
