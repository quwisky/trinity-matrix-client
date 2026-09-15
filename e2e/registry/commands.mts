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
    name: 'e2e:android:critical',
    command: 'nx run trinity-e2e-android:critical-journeys',
    kind: 'canonical',
    suiteIds: ['android.critical-journeys'],
  },
  {
    name: 'e2e:android:native-shell',
    command: 'nx run trinity-e2e-android:native-shell',
    kind: 'canonical',
    suiteIds: ['android.native-shell'],
  },
  {
    name: 'e2e:android:accounts',
    command: 'nx run trinity-e2e-android:accounts-workspace',
    kind: 'canonical',
    suiteIds: ['android.accounts-workspace'],
  },
  {
    name: 'e2e:android:identity',
    command: 'nx run trinity-e2e-android:identity-presence',
    kind: 'canonical',
    suiteIds: ['android.identity-presence'],
  },
  {
    name: 'e2e:android:sidebar-filter',
    command: 'nx run trinity-e2e-android:sidebar-filter',
    kind: 'canonical',
    suiteIds: ['android.sidebar-filter'],
  },
  {
    name: 'e2e:android:sidebar-touch',
    command: 'nx run trinity-e2e-android:sidebar-touch',
    kind: 'canonical',
    suiteIds: ['android.sidebar-touch'],
  },
  {
    name: 'e2e:android:room-tags',
    command: 'nx run trinity-e2e-android:room-tags',
    kind: 'canonical',
    suiteIds: ['android.room-tags'],
  },
  {
    name: 'e2e:android:room-read-state',
    command: 'nx run trinity-e2e-android:room-read-state',
    kind: 'canonical',
    suiteIds: ['android.room-read-state'],
  },
  {
    name: 'e2e:android:room-list',
    command: 'nx run trinity-e2e-android:room-list',
    kind: 'canonical',
    suiteIds: ['android.room-list'],
  },
  {
    name: 'e2e:android:unread-badges',
    command: 'nx run trinity-e2e-android:unread-badges',
    kind: 'canonical',
    suiteIds: ['android.unread-badges'],
  },
  {
    name: 'e2e:android:leave-room',
    command: 'nx run trinity-e2e-android:leave-room',
    kind: 'canonical',
    suiteIds: ['android.leave-room'],
  },
  {
    name: 'e2e:android:recent-activity',
    command: 'nx run trinity-e2e-android:recent-activity',
    kind: 'canonical',
    suiteIds: ['android.recent-activity'],
  },
  {
    name: 'e2e:android:room-filter-spaceless',
    command: 'nx run trinity-e2e-android:room-filter-spaceless',
    kind: 'canonical',
    suiteIds: ['android.room-filter-spaceless'],
  },
  {
    name: 'e2e:android:space-curation-create-join',
    command: 'nx run trinity-e2e-android:space-curation-create-join',
    kind: 'canonical',
    suiteIds: ['android.space-curation-create-join'],
  },
  {
    name: 'e2e:android:space-room-order',
    command: 'nx run trinity-e2e-android:space-room-order',
    kind: 'canonical',
    suiteIds: ['android.space-room-order'],
  },
  {
    name: 'e2e:android:room-http-error-recovery',
    command: 'nx run trinity-e2e-android:room-http-error-recovery',
    kind: 'canonical',
    suiteIds: ['android.room-http-error-recovery'],
  },
  {
    name: 'e2e:android:room-settings-mobile',
    command: 'nx run trinity-e2e-android:room-settings-mobile',
    kind: 'canonical',
    suiteIds: ['android.room-settings-mobile'],
  },
  {
    name: 'e2e:android:space-settings-mobile',
    command: 'nx run trinity-e2e-android:space-settings-mobile',
    kind: 'canonical',
    suiteIds: ['android.space-settings-mobile'],
  },
  {
    name: 'e2e:android:space-settings-resilience',
    command: 'nx run trinity-e2e-android:space-settings-resilience',
    kind: 'canonical',
    suiteIds: ['android.space-settings-resilience'],
  },
  {
    name: 'e2e:android:space-settings-core',
    command: 'nx run trinity-e2e-android:space-settings-core',
    kind: 'canonical',
    suiteIds: ['android.space-settings-core'],
  },
  {
    name: 'e2e:android:space-leave',
    command: 'nx run trinity-e2e-android:space-leave',
    kind: 'canonical',
    suiteIds: ['android.space-leave'],
  },
  {
    name: 'e2e:android:room-tombstone',
    command: 'nx run trinity-e2e-android:room-tombstone',
    kind: 'canonical',
    suiteIds: ['android.room-tombstone'],
  },
  {
    name: 'e2e:android:member-details-promotion',
    command: 'nx run trinity-e2e-android:member-details-promotion',
    kind: 'canonical',
    suiteIds: ['android.member-details-promotion'],
  },
  {
    name: 'e2e:android:member-role-classification',
    command: 'nx run trinity-e2e-android:member-role-classification',
    kind: 'canonical',
    suiteIds: ['android.member-role-classification'],
  },
  {
    name: 'e2e:android:member-role-live-updates',
    command: 'nx run trinity-e2e-android:member-role-live-updates',
    kind: 'canonical',
    suiteIds: ['android.member-role-live-updates'],
  },
  {
    name: 'e2e:android:message-moderation',
    command: 'nx run trinity-e2e-android:message-moderation',
    kind: 'canonical',
    suiteIds: ['android.message-moderation'],
  },
  {
    name: 'e2e:android:member-moderation',
    command: 'nx run trinity-e2e-android:member-moderation',
    kind: 'canonical',
    suiteIds: ['android.member-moderation'],
  },
  {
    name: 'e2e:android:room-unban',
    command: 'nx run trinity-e2e-android:room-unban',
    kind: 'canonical',
    suiteIds: ['android.room-unban'],
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
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'critical-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:critical-journeys; fi',
    tier: 'pull-request',
    suiteIds: ['android.critical-journeys'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'native-shell-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:native-shell; fi',
    tier: 'pull-request',
    suiteIds: ['android.native-shell'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'space-settings-core-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-settings-core; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-settings-core'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'space-leave-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-leave; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-leave'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'room-tombstone-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-tombstone; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-tombstone'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'member-details-promotion-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:member-details-promotion; fi',
    tier: 'pull-request',
    suiteIds: ['android.member-details-promotion'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "2" ]; then echo \'member-role-classification-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:member-role-classification; fi',
    tier: 'pull-request',
    suiteIds: ['android.member-role-classification'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "4" ]; then echo \'member-role-live-updates-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:member-role-live-updates; fi',
    tier: 'pull-request',
    suiteIds: ['android.member-role-live-updates'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "3" ]; then echo \'accounts-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:accounts-workspace; fi',
    tier: 'pull-request',
    suiteIds: ['android.accounts-workspace'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "3" ]; then echo \'message-moderation-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:message-moderation; fi',
    tier: 'pull-request',
    suiteIds: ['android.message-moderation'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "3" ]; then echo \'member-moderation-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:member-moderation; fi',
    tier: 'pull-request',
    suiteIds: ['android.member-moderation'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "3" ]; then echo \'room-unban-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-unban; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-unban'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "4" ]; then echo \'identity-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:identity-presence; fi',
    tier: 'pull-request',
    suiteIds: ['android.identity-presence'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "4" ]; then echo \'room-settings-mobile-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-settings-mobile; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-settings-mobile'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "4" ]; then echo \'space-settings-mobile-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-settings-mobile; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-settings-mobile'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "4" ]; then echo \'space-settings-resilience-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-settings-resilience; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-settings-resilience'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'sidebar-filter-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:sidebar-filter; fi',
    tier: 'pull-request',
    suiteIds: ['android.sidebar-filter'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'sidebar-touch-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:sidebar-touch; fi',
    tier: 'pull-request',
    suiteIds: ['android.sidebar-touch'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'room-tags-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-tags; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-tags'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'room-read-state-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-read-state; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-read-state'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'room-list-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-list; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-list'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'unread-badges-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:unread-badges; fi',
    tier: 'pull-request',
    suiteIds: ['android.unread-badges'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'leave-room-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:leave-room; fi',
    tier: 'pull-request',
    suiteIds: ['android.leave-room'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'recent-activity-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:recent-activity; fi',
    tier: 'pull-request',
    suiteIds: ['android.recent-activity'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'room-filter-spaceless-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-filter-spaceless; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-filter-spaceless'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'space-curation-create-join-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-curation-create-join; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-curation-create-join'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'space-room-order-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:space-room-order; fi',
    tier: 'pull-request',
    suiteIds: ['android.space-room-order'],
  },
  {
    command:
      'if [ "${{ matrix.shard }}" = "1" ]; then echo \'room-http-error-recovery-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm exec nx run trinity-e2e-android:room-http-error-recovery; fi',
    tier: 'pull-request',
    suiteIds: ['android.room-http-error-recovery'],
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
