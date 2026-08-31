import type {
  E2EAggregateTarget,
  E2ECiEntrypoint,
  E2EPackageScriptContract,
} from './types.mts';

const compatibilityRelease =
  'first release after the E2E lifecycle migration completes';

export const E2E_AGGREGATE_TARGETS = [
  { target: 'e2e-pr', selection: { kind: 'ci-tier', value: 'pull-request' } },
  { target: 'e2e-all', selection: { kind: 'all' } },
  {
    target: 'e2e-browser',
    selection: { kind: 'environment', value: 'browser' },
  },
  {
    target: 'e2e-components',
    selection: { kind: 'environment', value: 'components' },
  },
  {
    target: 'e2e-protocol',
    selection: { kind: 'environment', value: 'protocol' },
  },
  {
    target: 'e2e-electron',
    selection: { kind: 'environment', value: 'electron' },
  },
  {
    target: 'e2e-web',
    selection: { kind: 'environment', value: 'web' },
  },
  {
    target: 'e2e-android',
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
    suiteIds: ['web.production-pwa', 'web.production-renderer'],
  },
  {
    name: 'e2e:android',
    command: 'nx run trinity-e2e:e2e-android',
    kind: 'canonical',
    suiteIds: ['android.installed-webview'],
  },
  {
    name: 'e2e:verify',
    command: 'nx run trinity-e2e:protocol-verify-sas',
    kind: 'compatibility',
    suiteIds: ['protocol.verify-sas'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:verify:qr',
    command: 'nx run trinity-e2e:protocol-verify-qr',
    kind: 'compatibility',
    suiteIds: ['protocol.verify-qr'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:media',
    command: 'nx run trinity-e2e:protocol-media',
    kind: 'compatibility',
    suiteIds: ['protocol.media'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:threads',
    command: 'nx run trinity-e2e:protocol-threads',
    kind: 'compatibility',
    suiteIds: ['protocol.threads'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:reply',
    command: 'nx run trinity-e2e:protocol-reply',
    kind: 'compatibility',
    suiteIds: ['protocol.reply'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:spaces',
    command: 'nx run trinity-e2e:protocol-spaces',
    kind: 'compatibility',
    suiteIds: ['protocol.spaces'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:rooms',
    command: 'nx run trinity-e2e:protocol-rooms',
    kind: 'compatibility',
    suiteIds: ['protocol.rooms'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:search',
    command: 'nx run trinity-e2e:protocol-search',
    kind: 'compatibility',
    suiteIds: ['protocol.search'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'e2e:emoji',
    command: 'nx run trinity-e2e:protocol-emoji',
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
    command: 'nx run trinity-e2e:protocol-crypto-spike-chromium',
    kind: 'compatibility',
    suiteIds: ['protocol.crypto-spike-chromium'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'spike:webkit',
    command: 'nx run trinity-e2e:protocol-crypto-spike-webkit',
    kind: 'compatibility',
    suiteIds: ['protocol.crypto-spike-webkit'],
    removalAfterRelease: compatibilityRelease,
  },
  {
    name: 'smoke:login',
    command: 'nx run trinity-e2e:protocol-login-smoke',
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
    command: 'xvfb-run -a pnpm electron:e2e',
    suiteIds: ['electron.full'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-components:storybook',
    suiteIds: ['components.storybook'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-web:production-renderer',
    suiteIds: ['web.production-renderer'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-components:styling',
    suiteIds: ['components.styling'],
  },
  {
    command: 'pnpm exec nx run trinity-e2e-browser:e2e',
    suiteIds: ['browser.canonical'],
  },
  {
    command: 'pnpm e2e:verify:qr',
    suiteIds: ['protocol.verify-qr'],
  },
  {
    command:
      'TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm e2e:android -- --fail-on-flaky-tests --shard=${{ matrix.shard }}/4',
    suiteIds: ['android.installed-webview'],
  },
] as const satisfies readonly E2ECiEntrypoint[];
