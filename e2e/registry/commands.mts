import type {
  E2EAggregateTarget,
  E2ECiEntrypoint,
  E2EPackageScriptContract,
} from './types.mts';

const compatibilityRelease =
  'after one released changelog cycle with documented replacements, zero repository or CI references, and no reported migration failures';

export const E2E_AGGREGATE_TARGETS = [
  {
    target: 'e2e-pr',
    unavailablePolicy: 'fail',
    selection: { kind: 'ci-tier', value: 'pull-request' },
  },
  {
    target: 'e2e-scheduled',
    unavailablePolicy: 'fail',
    selection: { kind: 'ci-tier', value: 'scheduled' },
  },
  {
    target: 'e2e-all',
    unavailablePolicy: 'skip',
    selection: { kind: 'all' },
  },
  {
    target: 'e2e-browser',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'browser' },
  },
  {
    target: 'e2e-components',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'components' },
  },
  {
    target: 'e2e-protocol',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'protocol' },
  },
  {
    target: 'e2e-electron',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'electron' },
  },
  {
    target: 'e2e-web',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'web' },
  },
  {
    target: 'e2e-android',
    unavailablePolicy: 'fail',
    selection: { kind: 'environment', value: 'android' },
  },
] as const satisfies readonly E2EAggregateTarget[];

export const E2E_PACKAGE_SCRIPTS = [
  {
    name: 'e2e',
    command: 'nx run trinity-e2e:e2e-pr',
    kind: 'canonical',
    suiteIds: [],
  },
  {
    name: 'e2e:all',
    command: 'nx run trinity-e2e:e2e-all',
    kind: 'canonical',
    suiteIds: [],
  },
  {
    name: 'e2e:scheduled',
    command: 'nx run trinity-e2e:e2e-scheduled',
    kind: 'canonical',
    suiteIds: [
      'components.scrollbars',
      'protocol.media',
      'protocol.threads',
      'protocol.reply',
      'protocol.spaces',
      'protocol.rooms',
      'protocol.search',
      'protocol.emoji',
      'protocol.crypto-spike-chromium',
      'protocol.crypto-spike-webkit',
    ],
  },
  {
    name: 'e2e:browser',
    command: 'nx run trinity-e2e:e2e-browser',
    kind: 'canonical',
    suiteIds: ['browser.canonical'],
  },
  {
    name: 'e2e:components',
    command: 'nx run trinity-e2e:e2e-components',
    kind: 'canonical',
    suiteIds: [
      'components.storybook',
      'components.styling',
      'components.scrollbars',
    ],
  },
  {
    name: 'e2e:protocol',
    command: 'nx run trinity-e2e:e2e-protocol',
    kind: 'canonical',
    suiteIds: [
      'protocol.verify-sas',
      'protocol.verify-qr',
      'protocol.media',
      'protocol.threads',
      'protocol.reply',
      'protocol.spaces',
      'protocol.rooms',
      'protocol.search',
      'protocol.emoji',
      'protocol.verify-sas-selfcheck',
      'protocol.crypto-spike-chromium',
      'protocol.crypto-spike-webkit',
      'protocol.login-smoke',
    ],
  },
  {
    name: 'e2e:electron',
    command: 'nx run trinity-e2e:e2e-electron',
    kind: 'canonical',
    suiteIds: ['electron.smoke', 'electron.full'],
  },
  {
    name: 'e2e:web',
    command: 'nx run trinity-e2e:e2e-web',
    kind: 'canonical',
    suiteIds: [
      'web.production-pwa',
      'web.container',
      'web.production-renderer',
    ],
  },
  {
    name: 'e2e:android',
    command: 'nx run trinity-e2e:e2e-android',
    kind: 'canonical',
    suiteIds: ['android.installed-webview'],
  },
  {
    name: 'e2e:verify',
    command: 'nx run trinity-e2e-protocol:verify-sas',
    kind: 'compatibility',
    suiteIds: ['protocol.verify-sas'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:runner:chromium',
    command: 'nx run trinity-e2e-browser:runner-smoke',
    kind: 'canonical',
    suiteIds: ['runner.chromium'],
  },
  {
    name: 'e2e:runner:electron',
    command: 'nx run trinity-e2e-electron:runner-smoke',
    kind: 'canonical',
    suiteIds: ['runner.electron'],
  },
  {
    name: 'e2e:runner:android',
    command: 'nx run trinity-e2e-android:runner-smoke',
    kind: 'canonical',
    suiteIds: ['runner.android'],
  },
  {
    name: 'e2e:verify:qr',
    command: 'nx run trinity-e2e-protocol:verify-qr',
    kind: 'compatibility',
    suiteIds: ['protocol.verify-qr'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:media',
    command: 'nx run trinity-e2e-protocol:media',
    kind: 'compatibility',
    suiteIds: ['protocol.media'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:threads',
    command: 'nx run trinity-e2e-protocol:threads',
    kind: 'compatibility',
    suiteIds: ['protocol.threads'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:reply',
    command: 'nx run trinity-e2e-protocol:reply',
    kind: 'compatibility',
    suiteIds: ['protocol.reply'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:spaces',
    command: 'nx run trinity-e2e-protocol:spaces',
    kind: 'compatibility',
    suiteIds: ['protocol.spaces'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:rooms',
    command: 'nx run trinity-e2e-protocol:rooms',
    kind: 'compatibility',
    suiteIds: ['protocol.rooms'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:search',
    command: 'nx run trinity-e2e-protocol:search',
    kind: 'compatibility',
    suiteIds: ['protocol.search'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:emoji',
    command: 'nx run trinity-e2e-protocol:emoji',
    kind: 'compatibility',
    suiteIds: ['protocol.emoji'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:ui:shipped',
    command: 'nx run trinity-e2e-web:production-renderer',
    kind: 'compatibility',
    suiteIds: ['web.production-renderer'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'electron:e2e',
    command: 'nx run trinity-desktop:e2e',
    kind: 'compatibility',
    suiteIds: ['electron.full'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'electron:e2e:smoke',
    command: 'nx run trinity-desktop:e2e-smoke',
    kind: 'compatibility',
    suiteIds: ['electron.smoke'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'spike:chromium',
    command: 'nx run trinity-e2e-protocol:crypto-spike-chromium',
    kind: 'compatibility',
    suiteIds: ['protocol.crypto-spike-chromium'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'spike:webkit',
    command: 'nx run trinity-e2e-protocol:crypto-spike-webkit',
    kind: 'compatibility',
    suiteIds: ['protocol.crypto-spike-webkit'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'smoke:login',
    command: 'nx run trinity-e2e-protocol:login-smoke',
    kind: 'compatibility',
    suiteIds: ['protocol.login-smoke'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:verify:up',
    command: 'nx run trinity-e2e:synapse-up',
    kind: 'maintenance',
    suiteIds: [],
  },
  {
    name: 'e2e:verify:down',
    command: 'nx run trinity-e2e:synapse-down',
    kind: 'maintenance',
    suiteIds: [],
  },
] as const satisfies readonly E2EPackageScriptContract[];

export const E2E_CI_ENTRYPOINTS = [
  {
    command: 'xvfb-run -a pnpm nx run trinity-e2e-electron:full-prebuilt',
    tier: 'pull-request',
    suiteIds: ['electron.full'],
  },
  {
    command: 'xvfb-run -a pnpm nx run trinity-e2e-electron:runner-smoke',
    tier: 'pull-request',
    suiteIds: ['runner.electron'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-components:storybook',
    tier: 'pull-request',
    suiteIds: ['components.storybook'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-web:production-renderer',
    tier: 'pull-request',
    suiteIds: ['web.production-renderer'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-components:styling',
    tier: 'pull-request',
    suiteIds: ['components.styling'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-browser:e2e',
    tier: 'pull-request',
    suiteIds: ['browser.canonical'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-browser:runner-smoke',
    tier: 'pull-request',
    suiteIds: ['runner.chromium'],
  },
  {
    command: 'pnpm e2e:verify:qr',
    tier: 'pull-request',
    suiteIds: ['protocol.verify-qr'],
  },
  {
    command:
      'TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm e2e:android -- --fail-on-flaky-tests --shard=${{ matrix.shard }}/4',
    tier: 'pull-request',
    suiteIds: ['android.installed-webview'],
  },
  {
    command:
      'TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:runner-smoke',
    tier: 'pull-request',
    suiteIds: ['runner.android'],
  },
  {
    command: 'pnpm e2e:scheduled',
    tier: 'scheduled',
    suiteIds: [
      'components.scrollbars',
      'protocol.media',
      'protocol.threads',
      'protocol.reply',
      'protocol.spaces',
      'protocol.rooms',
      'protocol.search',
      'protocol.emoji',
      'protocol.crypto-spike-chromium',
      'protocol.crypto-spike-webkit',
    ],
  },
] as const satisfies readonly E2ECiEntrypoint[];
