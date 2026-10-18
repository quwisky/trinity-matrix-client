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

const ANDROID_NS = 'xmlns:android="http://schemas.android.com/apk/res/android"';

function pushLibraryManifest(
  service = [
    '<service',
    '    android:name="dev.trinityproject.trinity.push.TrinityMessagingService"',
    '    android:exported="false">',
    '  <intent-filter>',
    '    <action android:name="com.google.firebase.MESSAGING_EVENT" />',
    '  </intent-filter>',
    '</service>',
  ].join('\n'),
) {
  return `<manifest ${ANDROID_NS}><application>${service}</application></manifest>`;
}

function appManifest(
  service = [
    '<service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService"',
    '  tools:node="remove" />',
  ].join('\n'),
) {
  return [
    `<manifest ${ANDROID_NS}`,
    '    xmlns:tools="http://schemas.android.com/tools">',
    '  <application>',
    '    <activity android:name=".MainActivity">',
    '      <intent-filter><data android:scheme="dev.trinityproject.trinity" /></intent-filter>',
    '    </activity>',
    `    ${service}`,
    '  </application>',
    '</manifest>',
  ].join('\n');
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
      ':aparajita-capacitor-biometric-auth',
      ':capacitor-app',
      ':capacitor-browser',
      ':capacitor-filesystem',
      ':capacitor-local-notifications',
      ':capacitor-privacy-screen',
      ':capacitor-push-notifications',
      ':capacitor-status-bar',
      ':capawesome-capacitor-badge',
      ':trinity-capacitor-app-lock',
      ':trinity-capacitor-push',
    ].join('\n'),
    iosPlugins: [
      'AparajitaCapacitorSecureStorage',
      'AparajitaCapacitorBiometricAuth',
      'CapacitorApp',
      'CapacitorBrowser',
      'CapacitorFilesystem',
      'CapacitorLocalNotifications',
      'CapacitorPrivacyScreen',
      'CapacitorPushNotifications',
      'CapacitorStatusBar',
      'CapawesomeCapacitorBadge',
      'TrinityCapacitorAppLock',
      'TrinityCapacitorAuthSession',
      'TrinityCapacitorPush',
    ].join('\n'),
    androidManifest: appManifest(),
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
    androidAppLockPlugin: [
      '@CapacitorPlugin(name = "TrinityAppLock")',
      'public class AppLockPlugin extends Plugin {',
    ].join('\n'),
    iosAppLockPlugin: [
      '@objc(AppLockPlugin)',
      'public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {',
      '    public let jsName = "TrinityAppLock"',
    ].join('\n'),
    iosAuthSessionPlugin: [
      '@objc(AuthSessionPlugin)',
      'public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {',
      '    public let jsName = "TrinityAuthSession"',
    ].join('\n'),
    androidPushLibraryManifest: pushLibraryManifest(),
    androidPushAppearance: [
      '<drawable name="trinity_push_small_icon">@drawable/ic_stat_trinity</drawable>',
      '<color name="trinity_push_color">@color/ic_launcher_background</color>',
    ].join('\n'),
  };
}

function errorsAfter(mutate) {
  const input = validInput();
  mutate(input);
  const errors = [];
  validateNativeHostContract(input, errors);
  return errors;
}

describe('native host contract', () => {
  it('validates the checked-in Android and iOS hosts', () => {
    expect(validateCurrentNativeHosts).not.toThrow();
  });

  it('accepts each plugin named exactly, in the shapes cap update writes', () => {
    const input = validInput();
    const android = input.androidPlugins.split('\n');
    const ios = input.iosPlugins.split('\n');
    input.androidPlugins = android
      .map(
        (name) =>
          `include '${name}'\nproject('${name}').projectDir = new File('../x/android')`,
      )
      .join('\n');
    input.iosPlugins = ios
      .map(
        (name) =>
          `.package(name: "${name}", path: "../x"),\n.product(name: "${name}", package: "${name}"),`,
      )
      .join('\n');
    const errors = [];

    validateNativeHostContract(input, errors);

    expect(errors.filter((error) => error.includes('plugin wiring'))).toEqual(
      [],
    );
    expect(ios).toContain('CapacitorApp');
    expect(ios).toContain('TrinityCapacitorAppLock');
    expect(android).toContain(':capacitor-app');
    expect(android).toContain(':trinity-capacitor-app-lock');
  });

  it('accepts the push library service with reordered attributes', () => {
    const errors = errorsAfter((input) => {
      input.androidPushLibraryManifest = pushLibraryManifest(
        [
          '<service android:exported="false"',
          '    android:name=".TrinityMessagingService">',
          '  <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter>',
          '</service>',
        ].join('\n'),
      );
    });

    expect(errors).toEqual([]);
  });

  it('accepts a reformatted push plugin declaration and reordered app marker', () => {
    const errors = errorsAfter((input) => {
      input.androidManifest = appManifest(
        '<service xmlns:t="http://schemas.android.com/tools" t:node="remove"\n' +
          '    android:name="com.capacitorjs.plugins.pushnotifications.MessagingService"/>',
      );
      input.androidPushPlugin = input.androidPushPlugin.replace(
        '@CapacitorPlugin(name = "PushHandoff")\npublic class',
        '@CapacitorPlugin( name="PushHandoff" )\n\n\npublic   class',
      );
      input.iosPushPlugin = input.iosPushPlugin
        .replace(
          'PushHandoffPlugin: CAPPlugin, CAPBridgedPlugin',
          'PushHandoffPlugin :\n    CAPPlugin,\n    CAPBridgedPlugin',
        )
        .replace(
          'public let jsName = "PushHandoff"',
          'public  let jsName="PushHandoff"',
        );
    });

    expect(errors).toEqual([]);
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
      const errors = errorsAfter((input) => {
        input.capacitor = capacitor;
      });

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
      const errors = errorsAfter((input) => {
        input.capacitor = capacitor;
      });

      expect(errors, capacitor).toEqual([]);
    }
  });

  it('rejects a native lifecycle hidden outside Nx', () => {
    const errors = errorsAfter((input) => {
      input.projects.android.targets.run = undefined;
    });

    expect(errors).toContain(
      'android run must launch the synchronized native host',
    );
  });

  it('rejects a host that no longer builds the shared renderer before sync', () => {
    const errors = errorsAfter((input) => {
      input.projects.ios.targets.sync.dependsOn = [];
    });

    expect(errors).toContain(
      'ios sync must build and copy the shared production renderer',
    );
  });

  it('rejects platform capability drift', () => {
    const errors = errorsAfter((input) => {
      input.capabilityAdapter = input.capabilityAdapter.replace(
        "platform === 'android' ? (['back'] as const) : []",
        "// platform === 'android' ? (['back'] as const) : []",
      );
    });

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
    const errors = errorsAfter(mutate);

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
      'privacy-screen Android module',
      'androidPlugins',
      ':capacitor-privacy-screen',
      '// :capacitor-privacy-screen',
      'Android host is missing plugin wiring: :capacitor-privacy-screen',
    ],
    [
      'privacy-screen Swift package',
      'iosPlugins',
      'CapacitorPrivacyScreen',
      '// CapacitorPrivacyScreen',
      'iOS host is missing plugin wiring: CapacitorPrivacyScreen',
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
      const errors = errorsAfter((input) => {
        input[field] = input[field].replace(active, comment);
      });

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
      'an App lock plugin hidden from the Android CLI',
      (input) => {
        input.androidAppLockPlugin = input.androidAppLockPlugin.replace(
          '@CapacitorPlugin',
          '// @CapacitorPlugin',
        );
      },
      'Android TrinityAppLock plugin must be discoverable by cap sync',
    ],
    [
      'an App lock instance plugin, which automatic registration skips',
      (input) => {
        input.iosAppLockPlugin = input.iosAppLockPlugin.replace(
          'CAPPlugin, CAPBridgedPlugin',
          'CAPInstancePlugin, CAPBridgedPlugin',
        );
      },
      'iOS TrinityAppLock plugin must be discoverable by cap sync',
    ],
    [
      'an App lock plugin missing from the Android host',
      (input) => {
        input.androidPlugins = input.androidPlugins.replace(
          ':trinity-capacitor-app-lock',
          '',
        );
      },
      'Android host is missing plugin wiring: :trinity-capacitor-app-lock',
    ],
    [
      'an App lock plugin missing from the iOS host',
      (input) => {
        input.iosPlugins = input.iosPlugins.replace(
          'TrinityCapacitorAppLock',
          '',
        );
      },
      'iOS host is missing plugin wiring: TrinityCapacitorAppLock',
    ],
    [
      'an auth session instance plugin, which automatic registration skips',
      (input) => {
        input.iosAuthSessionPlugin = input.iosAuthSessionPlugin.replace(
          'CAPPlugin, CAPBridgedPlugin',
          'CAPInstancePlugin, CAPBridgedPlugin',
        );
      },
      'iOS TrinityAuthSession plugin must be discoverable by cap sync',
    ],
    [
      'an auth session plugin missing from the iOS host',
      (input) => {
        input.iosPlugins = input.iosPlugins.replace(
          'TrinityCapacitorAuthSession',
          '',
        );
      },
      'iOS host is missing plugin wiring: TrinityCapacitorAuthSession',
    ],
    [
      'an iOS plugin named only inside a longer package name',
      (input) => {
        input.iosPlugins = input.iosPlugins.replace(/^CapacitorApp$/mu, '');
      },
      'iOS host is missing plugin wiring: CapacitorApp',
    ],
    [
      'an iOS plugin replaced by one with a longer name',
      (input) => {
        input.iosPlugins = input.iosPlugins.replace(
          /^CapacitorApp$/mu,
          'CapacitorAppX',
        );
      },
      'iOS host is missing plugin wiring: CapacitorApp',
    ],
    [
      'an iOS plugin replaced by a prefix of its name',
      (input) => {
        input.iosPlugins = input.iosPlugins.replace(
          /^CapacitorApp$/mu,
          'CapacitorAp',
        );
      },
      'iOS host is missing plugin wiring: CapacitorApp',
    ],
    [
      'an Android module named only as the prefix of a longer module',
      (input) => {
        input.androidPlugins = input.androidPlugins.replace(
          /^:capacitor-app$/mu,
          ':capacitor-app-lock',
        );
      },
      'Android host is missing plugin wiring: :capacitor-app',
    ],
    [
      'an Android module named only inside a longer module',
      (input) => {
        input.androidPlugins = input.androidPlugins.replace(
          /^:trinity-capacitor-app-lock$/mu,
          ':trinity-capacitor-app-lock-legacy',
        );
      },
      'Android host is missing plugin wiring: :trinity-capacitor-app-lock',
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
        input.androidManifest = appManifest('');
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
      'a push library without the messaging service',
      (input) => {
        input.androidPushLibraryManifest = pushLibraryManifest('');
      },
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
    ],
    [
      'a push library service without the FCM action',
      (input) => {
        input.androidPushLibraryManifest = pushLibraryManifest(
          '<service android:name="dev.trinityproject.trinity.push.TrinityMessagingService" />',
        );
      },
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
    ],
    [
      'a self-closing push library service beside another FCM service',
      (input) => {
        input.androidPushLibraryManifest = pushLibraryManifest(
          [
            '<service android:name="dev.trinityproject.trinity.push.TrinityMessagingService" />',
            '<service android:name="com.example.OtherService">',
            '  <intent-filter>',
            '    <action android:name="com.google.firebase.MESSAGING_EVENT" />',
            '  </intent-filter>',
            '</service>',
          ].join('\n'),
        );
      },
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
    ],
    [
      'a removal marker on a different app service',
      (input) => {
        input.androidManifest = appManifest(
          '<service android:name="com.example.Other" tools:node="remove" />',
        );
      },
      'Android host must remove the push plugin MessagingService from the app manifest',
    ],
    [
      'a push plugin service kept in the app manifest',
      (input) => {
        input.androidManifest = appManifest(
          '<service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService" tools:node="merge" />',
        );
      },
      'Android host must remove the push plugin MessagingService from the app manifest',
    ],
    [
      'a push library service directly under the manifest',
      (input) => {
        input.androidPushLibraryManifest = `<manifest ${ANDROID_NS}><service android:name=".TrinityMessagingService"><intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter></service></manifest>`;
      },
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
    ],
    [
      'a push library manifest that is not well-formed XML',
      (input) => {
        input.androidPushLibraryManifest = '<manifest><application>';
      },
      'Capacitor push library manifest is not well-formed XML',
    ],
    [
      'an app manifest that is not well-formed XML',
      (input) => {
        input.androidManifest = '<manifest><application>';
      },
      'Android host manifest is not well-formed XML',
    ],
    [
      'an iOS plugin name with spaces inside @objc()',
      (input) => {
        input.iosPushPlugin = input.iosPushPlugin.replace(
          '@objc(PushHandoffPlugin)',
          '@objc( PushHandoffPlugin )',
        );
      },
      'iOS PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'an Android plugin class with a double space the CLI cannot match',
      (input) => {
        input.androidPushPlugin = input.androidPushPlugin.replace(
          'class PushHandoffPlugin',
          'class  PushHandoffPlugin',
        );
      },
      'Android PushHandoff plugin must be discoverable by cap sync',
    ],
    [
      'a commented-out push library service',
      (input) => {
        input.androidPushLibraryManifest = `<!-- ${input.androidPushLibraryManifest} -->`;
      },
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
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
    const errors = errorsAfter(mutate);

    expect(errors).toContain(expected);
  });
});
