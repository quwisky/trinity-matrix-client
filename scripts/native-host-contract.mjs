import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const workspaceRoot = join(import.meta.dirname, '..');

const ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android';
const TOOLS_NAMESPACE = 'http://schemas.android.com/tools';

const hosts = {
  android: {
    projectName: 'trinity-android',
    projectPath: 'android/project.json',
    buildCommand: './gradlew assembleDebug',
    openCommand: 'pnpm exec cap open android',
    runCommand: 'pnpm exec cap run android',
    syncCommand: 'pnpm exec cap sync android',
    verifyNativeCommand: './gradlew testDebugUnitTest',
    e2eCommand: 'pnpm exec nx run trinity-e2e-mobile:e2e',
    packageScripts: {
      'e2e:mobile': 'nx run trinity-e2e:e2e-mobile',
      'android:sync': 'nx run trinity-android:sync',
      'android:run': 'nx run trinity-android:run',
      'android:build': 'nx run trinity-android:build',
      'android:verify': 'nx run trinity-android:verify',
    },
  },
  ios: {
    projectName: 'trinity-ios',
    projectPath: 'ios/project.json',
    buildCommand: 'pnpm exec cap build ios --scheme App',
    openCommand: 'pnpm exec cap open ios',
    runCommand: 'pnpm exec cap run ios',
    syncCommand: 'pnpm exec cap sync ios',
    verifyNativeCommand:
      'xcodebuild -project App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO',
    packageScripts: {
      'ios:sync': 'nx run trinity-ios:sync',
      'ios:run': 'nx run trinity-ios:run',
      'ios:build': 'nx run trinity-ios:build',
      'ios:verify': 'nx run trinity-ios:verify',
    },
  },
};

const requiredTags = [
  'type:app',
  'scope:matrix',
  'role:app',
  'capability:composition',
];

// The accepted `loggingBehavior` values, whitespace-normalized: always off, or off unless
// a local build sets TRINITY_CAPACITOR_LOGS=1 at sync time.
const CAPACITOR_LOGGING_OFF = [
  "'none'",
  "process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'debug' : 'none'",
];

const androidPluginMarkers = [
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
];

const iosPluginMarkers = [
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
];

function read(path) {
  return readFileSync(join(workspaceRoot, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function withoutComments(source, preserveStrings = false) {
  let result = '';
  let index = 0;
  let quote;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (quote) {
      result += preserveStrings ? character : character === '\n' ? '\n' : ' ';
      if (character === '\\') {
        result += preserveStrings ? (next ?? '') : next === '\n' ? '\n' : ' ';
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      result += preserveStrings ? character : ' ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') result += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    result += character;
    index += 1;
  }

  return result;
}

// Repeated until nothing changes: one pass over overlapping or nested comments, such as
// `<!<!-- x -->-- y -->`, can join the pieces of a new `<!--`.
function withoutXmlComments(source) {
  let previous;
  let result = source;
  do {
    previous = result;
    result = result.replaceAll(/<!--(?:.|\n)*?-->/gu, '');
  } while (result !== previous);
  return result;
}

// Attribute order, quoting and layout are formatting; the contract reads the parsed
// <service> elements under <application>. Returns null for a manifest that is not
// well-formed XML, so callers report that instead of a rule passing vacuously.
function manifestServices(manifest) {
  try {
    const { document } = new JSDOM(manifest, {
      contentType: 'text/xml',
    }).window;
    return [...document.getElementsByTagName('service')]
      .filter((service) => service.parentElement?.tagName === 'application')
      .map((service) => ({
        name: service.getAttributeNS(ANDROID_NAMESPACE, 'name'),
        node: service.getAttributeNS(TOOLS_NAMESPACE, 'node'),
        actions: [...service.children]
          .filter((child) => child.tagName === 'intent-filter')
          .flatMap((filter) => [...filter.children])
          .filter((child) => child.tagName === 'action')
          .map((action) => action.getAttributeNS(ANDROID_NAMESPACE, 'name')),
      }));
  } catch {
    return null;
  }
}

/**
 * Whether `source` names `marker` as a whole token: `CapacitorApp` must not be satisfied by
 * `TrinityCapacitorAppLock`, nor `:capacitor-app` by a longer module name.
 */
function namesPlugin(source, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'u').test(source);
}

function dependsOnProjectTarget(target, project, dependencyTarget) {
  return target?.dependsOn?.some(
    (dependency) =>
      typeof dependency === 'object' &&
      dependency.target === dependencyTarget &&
      (dependency.projects === project ||
        dependency.projects?.includes(project)),
  );
}

export function validateNativeHostContract(input, errors, selectedHosts) {
  const capabilityCode = withoutComments(input.capabilityAdapter);
  const operationCode = withoutComments(input.operationAdapter);
  const androidPlugins = withoutComments(input.androidPlugins, true);
  const iosPlugins = withoutComments(input.iosPlugins, true);
  const androidManifest = withoutXmlComments(input.androidManifest);
  const iosInfo = withoutXmlComments(input.iosInfo);
  const hostNames = selectedHosts ?? Object.keys(hosts);
  for (const hostName of hostNames) {
    const contract = hosts[hostName];
    const project = input.projects[hostName];
    if (!contract || !project) {
      errors.push(`Unknown native host: ${hostName}`);
      continue;
    }

    if (
      project.name !== contract.projectName ||
      project.projectType !== 'application'
    ) {
      errors.push(`${hostName} must be a first-class Nx application`);
    }
    for (const tag of requiredTags) {
      if (!project.tags?.includes(tag)) {
        errors.push(`${hostName} host is missing ${tag}`);
      }
    }
    if (!project.implicitDependencies?.includes('trinity')) {
      errors.push(`${hostName} host must consume the shared Trinity renderer`);
    }

    const {
      sync,
      build,
      run,
      open,
      verify,
      'verify-native': verifyNative,
    } = project.targets ?? {};
    if (
      sync?.options?.command !== contract.syncCommand ||
      sync?.cache !== false ||
      !dependsOnProjectTarget(sync, 'trinity', 'build')
    ) {
      errors.push(
        `${hostName} sync must build and copy the shared production renderer`,
      );
    }
    if (
      build?.options?.command !== contract.buildCommand ||
      build?.cache !== false ||
      !build?.dependsOn?.includes('sync')
    ) {
      errors.push(
        `${hostName} build must package the synchronized native host`,
      );
    }
    if (
      run?.options?.command !== contract.runCommand ||
      run?.cache !== false ||
      !run?.dependsOn?.includes('sync')
    ) {
      errors.push(`${hostName} run must launch the synchronized native host`);
    }
    if (
      open?.options?.command !== contract.openCommand ||
      open?.cache !== false
    ) {
      errors.push(`${hostName} open must delegate to the uncached native host`);
    }
    if (
      verify?.options?.command !==
        `node scripts/native-host-contract.mjs ${hostName}` ||
      verifyNative?.options?.command !== contract.verifyNativeCommand ||
      verifyNative?.cache !== false ||
      !verifyNative?.dependsOn?.includes('sync')
    ) {
      errors.push(
        `${hostName} must expose static and toolchain-backed verification targets`,
      );
    }
    if (hostName === 'android') {
      const e2e = project.targets?.e2e;
      if (
        e2e?.options?.command !== contract.e2eCommand ||
        e2e?.cache !== false ||
        e2e?.parallelism !== false
      ) {
        errors.push(
          'android e2e must delegate to the uncached serialized installed-app journey',
        );
      }
    }
    for (const [script, command] of Object.entries(contract.packageScripts)) {
      const packageCommand = input.packageJson.scripts?.[script]?.replace(
        /^node scripts\/nx\.mjs run /u,
        'nx run ',
      );
      if (packageCommand !== command) {
        errors.push(`${script} must delegate to its Nx host target`);
      }
    }
  }

  if (!/webDir:\s*['"]www['"]/u.test(input.capacitor)) {
    errors.push('Capacitor hosts must consume the shared flat www artifact');
  }
  // Capacitor's bridge logs every plugin call's arguments (Android) and the start of every
  // result (iOS) to the device log, access tokens and sessions included. Exactly one
  // setting, outside comments, with no platform override, and off unless a local build
  // opts in.
  const loggingBehaviors = [
    ...input.capacitor
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')
      .matchAll(/loggingBehavior:\s*([^,}]+)/gu),
  ].map(([, value]) => value.replace(/\s+/gu, ' ').replaceAll('"', "'").trim());
  if (
    loggingBehaviors.length !== 1 ||
    !CAPACITOR_LOGGING_OFF.includes(loggingBehaviors[0])
  ) {
    errors.push(
      'Capacitor logging must default to none: the bridge logs plugin arguments and results',
    );
  }
  if (!capabilityCode.includes('capacitorSupportedOperations(')) {
    errors.push('Capacitor capability support must be explicit at composition');
  }
  for (const marker of ['platform ===', 'Capacitor.getPlatform(),']) {
    if (!capabilityCode.includes(marker)) {
      errors.push(`Capacitor capability manifest is missing: ${marker}`);
    }
  }
  const androidOperationGates = operationCode.match(
    /Capacitor\.getPlatform\(\)\s*===/gu,
  );
  if ((androidOperationGates?.length ?? 0) < 3) {
    errors.push(
      'Capacitor operation adapter must gate Back support, Back intents and backgrounding by platform',
    );
  }
  for (const marker of androidPluginMarkers) {
    if (!namesPlugin(androidPlugins, marker)) {
      errors.push(`Android host is missing plugin wiring: ${marker}`);
    }
  }
  for (const marker of iosPluginMarkers) {
    if (!namesPlugin(iosPlugins, marker)) {
      errors.push(`iOS host is missing plugin wiring: ${marker}`);
    }
  }
  // @trinity/capacitor-push is registered by `cap sync` (capacitor.plugins.json on Android,
  // packageClassList on iOS). A hand registration on top registers it twice. Discovery is a
  // regex in the Capacitor CLI: Android needs @CapacitorPlugin at the start of a line, iOS
  // takes the first @objc(Name) in the file and skips CAPInstancePlugin subclasses. A plugin
  // that is not registered leaves PushHandoffBridge inert without an error.
  if (
    withoutComments(input.androidHostActivity).includes('PushHandoffPlugin')
  ) {
    errors.push('Android host must not register PushHandoffPlugin by hand');
  }
  if (withoutComments(input.iosHostController).includes('PushHandoffPlugin')) {
    errors.push('iOS host must not register PushHandoffPlugin by hand');
  }
  // Mirrors the Capacitor CLI's `^@(?:CapacitorPlugin|NativePlugin)[\s\S]+?class ([\w]+)`
  // (android/update.js): one space after `class`, never more lenient than the CLI.
  if (
    !/^@CapacitorPlugin\(\s*name\s*=\s*"PushHandoff"\s*\)\s+public\s+class PushHandoffPlugin\s+extends\s+Plugin\b/mu.test(
      withoutComments(input.androidPushPlugin, true),
    )
  ) {
    errors.push('Android PushHandoff plugin must be discoverable by cap sync');
  }
  // The `@objc(Name)` patterns mirror the CLI's `/@objc\(([A-Za-z0-9_-]+)\)/`
  // (util/iosplugin.js): no inner whitespace, or cap sync skips the plugin silently.
  const iosPushPlugin = withoutComments(input.iosPushPlugin, true);
  if (
    input.iosPushPlugin.match(/@objc\(([A-Za-z0-9_-]+)\)/u)?.[1] !==
      'PushHandoffPlugin' ||
    !/@objc\(PushHandoffPlugin\)\s+public\s+class\s+PushHandoffPlugin\s*:\s*CAPPlugin\s*,\s*CAPBridgedPlugin\b/u.test(
      iosPushPlugin,
    ) ||
    !/public\s+let\s+jsName\s*=\s*"PushHandoff"/u.test(iosPushPlugin)
  ) {
    errors.push('iOS PushHandoff plugin must be discoverable by cap sync');
  }
  // @trinity/capacitor-app-lock follows the same discovery rules. A plugin cap sync misses
  // leaves AppLockPinBridge inert, so App lock would silently offer no PIN on that host.
  if (
    !/^@CapacitorPlugin\(\s*name\s*=\s*"TrinityAppLock"\s*\)\s+public\s+class AppLockPlugin\s+extends\s+Plugin\b/mu.test(
      withoutComments(input.androidAppLockPlugin, true),
    )
  ) {
    errors.push(
      'Android TrinityAppLock plugin must be discoverable by cap sync',
    );
  }
  const iosAppLockPlugin = withoutComments(input.iosAppLockPlugin, true);
  if (
    input.iosAppLockPlugin.match(/@objc\(([A-Za-z0-9_-]+)\)/u)?.[1] !==
      'AppLockPlugin' ||
    !/@objc\(AppLockPlugin\)\s+public\s+class\s+AppLockPlugin\s*:\s*CAPPlugin\s*,\s*CAPBridgedPlugin\b/u.test(
      iosAppLockPlugin,
    ) ||
    !/public\s+let\s+jsName\s*=\s*"TrinityAppLock"/u.test(iosAppLockPlugin)
  ) {
    errors.push('iOS TrinityAppLock plugin must be discoverable by cap sync');
  }
  // @trinity/capacitor-auth-session too (iOS only). A plugin cap sync misses hides legacy SSO
  // on iOS as it is hidden on Android.
  const iosAuthSessionPlugin = withoutComments(
    input.iosAuthSessionPlugin,
    true,
  );
  if (
    input.iosAuthSessionPlugin.match(/@objc\(([A-Za-z0-9_-]+)\)/u)?.[1] !==
      'AuthSessionPlugin' ||
    !/@objc\(AuthSessionPlugin\)\s+public\s+class\s+AuthSessionPlugin\s*:\s*CAPPlugin\s*,\s*CAPBridgedPlugin\b/u.test(
      iosAuthSessionPlugin,
    ) ||
    !/public\s+let\s+jsName\s*=\s*"TrinityAuthSession"/u.test(
      iosAuthSessionPlugin,
    )
  ) {
    errors.push(
      'iOS TrinityAuthSession plugin must be discoverable by cap sync',
    );
  }
  // The library cannot reference the app's resources; the host overrides its aliases with
  // the icon and accent its FCM meta-data names.
  const pushAppearance = withoutXmlComments(input.androidPushAppearance);
  if (
    !pushAppearance.includes(
      '<drawable name="trinity_push_small_icon">@drawable/ic_stat_trinity</drawable>',
    ) ||
    !pushAppearance.includes(
      '<color name="trinity_push_color">@color/ic_launcher_background</color>',
    )
  ) {
    errors.push('Android host must brand device-rendered push notifications');
  }
  // Without the library's own MESSAGING_EVENT service only Firebase's fallback service remains
  // and closed-app pushes silently stop rendering.
  const pushLibraryManifest = withoutXmlComments(
    input.androidPushLibraryManifest,
  );
  const libraryServices = manifestServices(pushLibraryManifest);
  if (libraryServices === null) {
    errors.push('Capacitor push library manifest is not well-formed XML');
  }
  const declaresMessagingService = (libraryServices ?? []).some(
    (service) =>
      [
        'dev.trinityproject.trinity.push.TrinityMessagingService',
        '.TrinityMessagingService',
      ].includes(service.name) &&
      service.actions.includes('com.google.firebase.MESSAGING_EVENT'),
  );
  if (!declaresMessagingService) {
    errors.push(
      'Capacitor push library must declare TrinityMessagingService for FCM messages',
    );
  }
  // The push plugin's own MESSAGING_EVENT service must stay removed here: a merge-rule marker
  // only applies from the higher-priority manifest. Otherwise FCM can deliver to it and
  // closed-app pushes silently stop rendering.
  const appServices = manifestServices(androidManifest);
  if (appServices === null) {
    errors.push('Android host manifest is not well-formed XML');
  }
  if (
    !(appServices ?? []).some(
      (service) =>
        service.name ===
          'com.capacitorjs.plugins.pushnotifications.MessagingService' &&
        service.node === 'remove',
    )
  ) {
    errors.push(
      'Android host must remove the push plugin MessagingService from the app manifest',
    );
  }
  if (
    !androidManifest.includes('android:scheme="dev.trinityproject.trinity"')
  ) {
    errors.push('Android host is missing the authentication deep-link scheme');
  }
  if (
    !iosInfo.includes('<key>CFBundleURLSchemes</key>') ||
    !iosInfo.includes('<string>dev.trinityproject.trinity</string>')
  ) {
    errors.push('iOS host is missing the authentication deep-link scheme');
  }
  if (
    !/<key>UIViewControllerBasedStatusBarAppearance<\/key>\s*<true\s*\/>/u.test(
      iosInfo,
    )
  ) {
    errors.push(
      'iOS host must delegate status-bar appearance to its view controller',
    );
  }
  // Xcode 27 builds abort at launch without the UIScene lifecycle, and iOS only
  // delivers the authentication redirect to the scene delegate once it is adopted.
  if (
    !iosInfo.includes('<key>UIApplicationSceneManifest</key>') ||
    !/<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/u.test(
      iosInfo,
    )
  ) {
    errors.push('iOS host must adopt the UIScene lifecycle');
  }
}

export function validateCurrentNativeHosts(selectedHosts) {
  const errors = [];
  validateNativeHostContract(
    {
      projects: {
        android: readJson(hosts.android.projectPath),
        ios: readJson(hosts.ios.projectPath),
      },
      packageJson: readJson('package.json'),
      capacitor: read('capacitor.config.ts'),
      capabilityAdapter: read(
        'libs/platform-native/src/lib/host-capabilities/host-capability.adapters.ts',
      ),
      operationAdapter: read(
        'libs/platform-native/src/lib/host-capabilities/host-operation.adapters.ts',
      ),
      androidPlugins: read('android/capacitor.settings.gradle'),
      iosPlugins: read('ios/App/CapApp-SPM/Package.swift'),
      androidManifest: read('android/app/src/main/AndroidManifest.xml'),
      iosInfo: read('ios/App/App/Info.plist'),
      androidHostActivity: read(
        'android/app/src/main/java/dev/trinityproject/trinity/MainActivity.java',
      ),
      iosHostController: read('ios/App/App/MainViewController.swift'),
      androidPushPlugin: read(
        'libs/native/capacitor-push/android/src/main/java/dev/trinityproject/trinity/PushHandoffPlugin.java',
      ),
      iosPushPlugin: read(
        'libs/native/capacitor-push/ios/Sources/PushHandoffPlugin/PushHandoffPlugin.swift',
      ),
      androidAppLockPlugin: read(
        'libs/native/capacitor-app-lock/android/src/main/java/dev/trinityproject/trinity/applock/AppLockPlugin.java',
      ),
      iosAppLockPlugin: read(
        'libs/native/capacitor-app-lock/ios/Sources/AppLockPlugin/AppLockPlugin.swift',
      ),
      iosAuthSessionPlugin: read(
        'libs/native/capacitor-auth-session/ios/Sources/AuthSessionPlugin/AuthSessionPlugin.swift',
      ),
      androidPushLibraryManifest: read(
        'libs/native/capacitor-push/android/src/main/AndroidManifest.xml',
      ),
      androidPushAppearance: read(
        'android/app/src/main/res/values/push_notification_appearance.xml',
      ),
    },
    errors,
    selectedHosts,
  );
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
}

async function runCli() {
  const selectedHosts = process.argv.slice(2);
  if (selectedHosts.some((host) => !Object.hasOwn(hosts, host))) {
    throw new Error(`Expected native host to be android or ios`);
  }
  validateCurrentNativeHosts(
    selectedHosts.length > 0 ? selectedHosts : undefined,
  );
  const count = selectedHosts.length || 2;
  process.stdout.write(
    `Native host contract is valid (${count} first-class Nx application${count === 1 ? '' : 's'}, shared renderer, explicit Capacitor capabilities).\n`,
  );
}

if (import.meta.main) {
  await runCli();
}
