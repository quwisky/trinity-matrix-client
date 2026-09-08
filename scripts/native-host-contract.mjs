import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = join(import.meta.dirname, '..');

const hosts = {
  android: {
    projectName: 'trinity-android',
    projectPath: 'android/project.json',
    buildCommand: './gradlew assembleDebug',
    openCommand: 'pnpm exec cap open android',
    runCommand: 'pnpm exec cap run android',
    syncCommand: 'pnpm exec cap sync android',
    verifyNativeCommand: './gradlew testDebugUnitTest',
    e2eCommand: 'pnpm exec nx run trinity-e2e-android:e2e',
    packageScripts: {
      'e2e:android': 'nx run trinity-e2e:e2e-android',
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

const androidPluginMarkers = [
  ':aparajita-capacitor-secure-storage',
  ':capacitor-app',
  ':capacitor-browser',
  ':capacitor-filesystem',
  ':capacitor-local-notifications',
  ':capacitor-push-notifications',
  ':capacitor-status-bar',
];

const iosPluginMarkers = [
  'AparajitaCapacitorSecureStorage',
  'CapacitorApp',
  'CapacitorBrowser',
  'CapacitorFilesystem',
  'CapacitorLocalNotifications',
  'CapacitorPushNotifications',
  'CapacitorStatusBar',
  'CapawesomeCapacitorBadge',
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

function withoutXmlComments(source) {
  return source.replaceAll(/<!--(?:.|\n)*?-->/gu, '');
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
  const iosProject = withoutComments(input.iosProject, true);
  const iosProjectCode = iosProject;
  const iosEntitlements = withoutXmlComments(input.iosEntitlements);
  const iosViewController = withoutComments(input.iosViewController, true);
  const iosRegistration = withoutComments(input.iosRegistration, true);
  const iosRegistrationPlugin = withoutComments(
    input.iosRegistrationPlugin,
    true,
  );
  const iosAppDelegate = withoutComments(input.iosAppDelegate, true);
  const iosCoordinator = withoutComments(input.iosCoordinator, true);
  const iosPushPackage = withoutComments(input.iosPushPackage, true);
  const iosStrings = input.iosStrings;
  const iosCopyScript = withoutComments(input.iosCopyScript, true);
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
    if (!androidPlugins.includes(marker)) {
      errors.push(`Android host is missing plugin wiring: ${marker}`);
    }
  }
  if (androidPlugins.includes(':capawesome-capacitor-badge')) {
    errors.push('Android badge writes must have only the Trinity native owner');
  }
  if (
    !withoutComments(input.androidAppBuild, true).includes(
      'me.leolin:ShortcutBadger:1.1.22@aar',
    )
  ) {
    errors.push(
      'Android badge owner requires the pinned ShortcutBadger adapter',
    );
  }
  for (const marker of iosPluginMarkers) {
    if (!iosPlugins.includes(marker)) {
      errors.push(`iOS host is missing plugin wiring: ${marker}`);
    }
  }
  if (!androidManifest.includes('android:scheme="eu.qwky.trinity"')) {
    errors.push('Android host is missing the authentication deep-link scheme');
  }
  if (
    !iosInfo.includes('<key>CFBundleURLSchemes</key>') ||
    !iosInfo.includes('<string>eu.qwky.trinity</string>')
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
  if (
    !iosProject.includes(
      'repositoryURL = "https://github.com/firebase/firebase-ios-sdk.git"',
    ) ||
    !iosProject.includes('kind = exactVersion;') ||
    !iosProject.includes('version = 12.13.0;') ||
    !iosProject.includes('productName = FirebaseCore;') ||
    !iosProject.includes('productName = FirebaseMessaging;')
  ) {
    errors.push(
      'iOS host must pin FirebaseCore and FirebaseMessaging to 12.13.0',
    );
  }
  if (
    !iosPushPackage.includes('name: "PushRegistration"') ||
    !iosPushPackage.includes('.target(name: "PushRegistration")') ||
    !iosCoordinator.includes('import Foundation') ||
    /import\s+(?:Firebase\w*|UIKit|Capacitor)\b/u.test(iosCoordinator) ||
    !iosProject.includes(
      'path = ../../PushRegistration/Sources/PushRegistration/TrinityPushTokenCoordinator.swift;',
    ) ||
    !/fileRef\s*=\s*B60600000000000000000024\s*;/u.test(iosProject) ||
    !/B60600000000000000000006\s*,/u.test(iosProject)
  ) {
    errors.push(
      'iOS host must compile the shared Foundation push coordinator from PushRegistration',
    );
  }
  if (
    (
      iosProject.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/gu) ??
      []
    ).length < 2 ||
    !iosEntitlements.includes('<key>aps-environment</key>')
  ) {
    errors.push(
      'iOS Debug and Release builds must include the APNs entitlement',
    );
  }
  if (
    !iosInfo.includes('<key>FirebaseAppDelegateProxyEnabled</key>') ||
    !/<key>FirebaseAppDelegateProxyEnabled<\/key>\s*<false\s*\/>/u.test(iosInfo)
  ) {
    errors.push('iOS Firebase App Delegate proxy must be disabled');
  }
  if (
    !iosViewController.includes(
      'registerPluginInstance(TrinityPushRegistrationPlugin())',
    ) ||
    !iosRegistrationPlugin.includes('let jsName = "TrinityPushRegistration"')
  ) {
    errors.push('iOS host must register the Trinity push bridge');
  }
  if (
    !iosProjectCode.includes('path = ../en.lproj/Localizable.strings;') ||
    !/fileRef\s*=\s*B60600000000000000000021\s*;/u.test(iosProjectCode) ||
    !/B60600000000000000000003\s*[;,]/u.test(iosProjectCode) ||
    !iosStrings.includes('"TRINITY_NOTIFICATION_TITLE"') ||
    !iosStrings.includes('"TRINITY_NEW_MESSAGE"')
  ) {
    errors.push('iOS host must bundle the native push localization keys');
  }
  if (
    !iosRegistration.includes(
      'Messaging.messaging().apnsToken = deviceToken',
    ) ||
    !iosRegistrationPlugin.includes('setAPNsToken(deviceToken)') ||
    !iosRegistration.includes('object: token') ||
    `${iosRegistration}\n${iosRegistrationPlugin}\n${iosAppDelegate}`.includes(
      'object: deviceToken',
    ) ||
    iosAppDelegate.includes('capacitorDidRegisterForRemoteNotifications') ||
    `${iosRegistration}\n${iosRegistrationPlugin}\n${iosAppDelegate}`.includes(
      'UNUserNotificationCenter',
    )
  ) {
    errors.push('iOS push bridge must forward only FCM String tokens');
  }
  if (
    !iosCopyScript.includes('if [ -s "${source_file}" ]') ||
    !iosCopyScript.includes('rm -f "${destination}"')
  ) {
    errors.push(
      'iOS Firebase config copy must safely handle missing or empty config',
    );
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
      androidAppBuild: read('android/app/build.gradle'),
      iosPlugins: read('ios/App/CapApp-SPM/Package.swift'),
      androidManifest: read('android/app/src/main/AndroidManifest.xml'),
      iosInfo: read('ios/App/App/Info.plist'),
      iosProject: read('ios/App/App.xcodeproj/project.pbxproj'),
      iosEntitlements: read('ios/App/App/App.entitlements'),
      iosViewController: read('ios/App/App/MainViewController.swift'),
      iosAppDelegate: read('ios/App/App/AppDelegate.swift'),
      iosCoordinator: read(
        'ios/PushRegistration/Sources/PushRegistration/TrinityPushTokenCoordinator.swift',
      ),
      iosPushPackage: read('ios/PushRegistration/Package.swift'),
      iosRegistration: read('ios/App/App/TrinityPushRegistration.swift'),
      iosRegistrationPlugin: read(
        'ios/App/App/TrinityPushRegistrationPlugin.swift',
      ),
      iosStrings: read('ios/App/en.lproj/Localizable.strings'),
      iosCopyScript: read('ios/App/App/copy-google-service-info.sh'),
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
