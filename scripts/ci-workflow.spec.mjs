/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { CODE_JOB_IDS } from './ci-classify.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const workflow = yaml('.github/workflows/ci.yml');

describe('CI execution contract', () => {
  it('classifies every PR and preserves the full code graph', () => {
    expect(workflow.on.pull_request?.['paths-ignore']).toBeUndefined();
    expect(workflow.jobs.classify.outputs.mode).toContain(
      'steps.classify.outputs.mode',
    );
    for (const id of CODE_JOB_IDS.filter((id) => id !== 'docs-gate')) {
      expect([workflow.jobs[id].needs].flat()).toContain('classify');
      expect(workflow.jobs[id].if).toContain('!cancelled()');
      expect(workflow.jobs[id].if).toContain(
        "needs.classify.outputs.mode != 'docs'",
      );
    }
    expect(workflow.jobs['android-e2e'].strategy.matrix.shard).toEqual([
      1, 2, 3, 4,
    ]);
    expect(workflow.jobs['android-e2e']['timeout-minutes']).toBe(
      '${{ matrix.shard == 3 && 240 || matrix.shard == 2 && 240 || matrix.shard == 4 && 180 || 120 }}',
    );
  });

  it('runs the complete documentation gate for docs and code changes', () => {
    const job = workflow.jobs['docs-gate'];
    expect(job.if).toContain('!cancelled()');
    expect(job.if).toContain("github.event_name != 'schedule'");
    expect(job.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'pnpm format:check',
      'pnpm nx test scripts',
      'pnpm nx test docs-site',
      'pnpm nx run docs-site:check',
      'pnpm nx run docs-site:assemble',
      'pnpm nx run docs-site:e2e',
    ]);
  });

  it('uploads only started suites, including hidden output, after ordinary failures', () => {
    const uploads = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter(
        (step) =>
          step.uses === './.github/actions/upload-playwright-diagnostics',
      );
    expect(uploads.length).toBe(66);
    const uploadIdentities = uploads.map((step) =>
      [step.with.surface, step.with.shard, step.with['report-path']].join('|'),
    );
    expect(new Set(uploadIdentities).size).toBe(uploads.length);
    expect(
      uploads.filter((step) => step.with.surface === 'android-runner-smoke'),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-critical-journeys',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-native-shell'),
    ).toHaveLength(1);
    const composerTypingUploads = uploads.filter(
      (step) => step.with.surface === 'android-composer-typing',
    );
    expect(composerTypingUploads).toHaveLength(1);
    expect(composerTypingUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.composer-typing/**',
    });
    const gifPickerUploads = uploads.filter(
      (step) => step.with.surface === 'android-gif-picker',
    );
    expect(gifPickerUploads).toHaveLength(1);
    expect(gifPickerUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.gif-picker/**',
    });
    const hideSystemMessagesUploads = uploads.filter(
      (step) => step.with.surface === 'android-hide-system-messages',
    );
    expect(hideSystemMessagesUploads).toHaveLength(1);
    expect(hideSystemMessagesUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.hide-system-messages/**',
    });
    const jumpToDateUploads = uploads.filter(
      (step) => step.with.surface === 'android-jump-to-date',
    );
    expect(jumpToDateUploads).toHaveLength(1);
    expect(jumpToDateUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.jump-to-date/**',
    });
    const jumpToLatestUploads = uploads.filter(
      (step) => step.with.surface === 'android-jump-to-latest',
    );
    expect(jumpToLatestUploads).toHaveLength(1);
    expect(jumpToLatestUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.jump-to-latest/**',
    });
    const linkPreviewUploads = uploads.filter(
      (step) => step.with.surface === 'android-link-preview',
    );
    expect(linkPreviewUploads).toHaveLength(1);
    expect(linkPreviewUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.link-preview/**',
    });
    const locationShareUploads = uploads.filter(
      (step) => step.with.surface === 'android-location-share',
    );
    expect(locationShareUploads).toHaveLength(1);
    expect(locationShareUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.location-share/**',
    });
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-accounts-workspace',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-identity-presence',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-sidebar-filter'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-sidebar-touch'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-room-tags'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-room-read-state'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-room-list'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-unread-badges'),
    ).toHaveLength(1);
    expect(
      uploads.filter((step) => step.with.surface === 'android-leave-room'),
    ).toHaveLength(1);
    const spaceLeaveUploads = uploads.filter(
      (step) => step.with.surface === 'android-space-leave',
    );
    expect(spaceLeaveUploads).toHaveLength(1);
    expect(spaceLeaveUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.space-leave/**',
    });
    const roomTombstoneUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-tombstone',
    );
    expect(roomTombstoneUploads).toHaveLength(1);
    expect(roomTombstoneUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-tombstone/**',
    });
    const messageModerationUploads = uploads.filter(
      (step) => step.with.surface === 'android-message-moderation',
    );
    expect(messageModerationUploads).toHaveLength(1);
    expect(messageModerationUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.message-moderation/**',
    });
    const memberModerationUploads = uploads.filter(
      (step) => step.with.surface === 'android-member-moderation',
    );
    expect(memberModerationUploads).toHaveLength(1);
    expect(memberModerationUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.member-moderation/**',
    });
    const memberDetailsPromotionUploads = uploads.filter(
      (step) => step.with.surface === 'android-member-details-promotion',
    );
    expect(memberDetailsPromotionUploads).toHaveLength(1);
    expect(memberDetailsPromotionUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.member-details-promotion/**',
    });
    const memberRoleClassificationUploads = uploads.filter(
      (step) => step.with.surface === 'android-member-role-classification',
    );
    expect(memberRoleClassificationUploads).toHaveLength(1);
    expect(memberRoleClassificationUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.member-role-classification/**',
    });
    const memberRoleLiveUpdatesUploads = uploads.filter(
      (step) => step.with.surface === 'android-member-role-live-updates',
    );
    expect(memberRoleLiveUpdatesUploads).toHaveLength(1);
    expect(memberRoleLiveUpdatesUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.member-role-live-updates/**',
    });
    const roomUnbanUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-unban',
    );
    expect(roomUnbanUploads).toHaveLength(1);
    expect(roomUnbanUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-unban/**',
    });
    const roomRosterLiveAuthorityUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-roster-live-authority',
    );
    expect(roomRosterLiveAuthorityUploads).toHaveLength(1);
    expect(roomRosterLiveAuthorityUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-roster-live-authority/**',
    });
    const roomAddressLifecycleUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-address-lifecycle',
    );
    expect(roomAddressLifecycleUploads).toHaveLength(1);
    expect(roomAddressLifecycleUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-address-lifecycle/**',
    });
    const roomAccessPolicyUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-access-policy',
    );
    expect(roomAccessPolicyUploads).toHaveLength(1);
    expect(roomAccessPolicyUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-access-policy/**',
    });
    const roomProfileSettingsUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-profile-settings',
    );
    expect(roomProfileSettingsUploads).toHaveLength(1);
    expect(roomProfileSettingsUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-profile-settings/**',
    });
    const roomForYouUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-for-you',
    );
    expect(roomForYouUploads).toHaveLength(1);
    expect(roomForYouUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-for-you/**',
    });
    const roomWidgetSettingsUploads = uploads.filter(
      (step) => step.with.surface === 'android-room-widget-settings',
    );
    expect(roomWidgetSettingsUploads).toHaveLength(1);
    expect(roomWidgetSettingsUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.room-widget-settings/**',
    });
    const accountPasswordChangeUploads = uploads.filter(
      (step) => step.with.surface === 'android-account-password-change',
    );
    expect(accountPasswordChangeUploads).toHaveLength(1);
    expect(accountPasswordChangeUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.account-password-change/**',
    });
    const clearAllDataUploads = uploads.filter(
      (step) => step.with.surface === 'android-clear-all-data',
    );
    expect(clearAllDataUploads).toHaveLength(1);
    expect(clearAllDataUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.clear-all-data/**',
    });
    const passwordRegistrationUploads = uploads.filter(
      (step) => step.with.surface === 'android-password-registration',
    );
    expect(passwordRegistrationUploads).toHaveLength(1);
    expect(passwordRegistrationUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.password-registration/**',
    });
    const oidcLoginUploads = uploads.filter(
      (step) => step.with.surface === 'android-oidc-login',
    );
    expect(oidcLoginUploads).toHaveLength(1);
    expect(oidcLoginUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.oidc-login/**',
    });
    const securitySettingsUploads = uploads.filter(
      (step) => step.with.surface === 'android-security-settings',
    );
    expect(securitySettingsUploads).toHaveLength(1);
    expect(securitySettingsUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.security-settings/**',
    });
    const recoveryResetUploads = uploads.filter(
      (step) => step.with.surface === 'android-recovery-reset',
    );
    expect(recoveryResetUploads).toHaveLength(1);
    expect(recoveryResetUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.recovery-reset/**',
    });
    const legacySsoUploads = uploads.filter(
      (step) => step.with.surface === 'android-legacy-sso',
    );
    expect(legacySsoUploads).toHaveLength(1);
    expect(legacySsoUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.legacy-sso/**',
    });
    const ssoRecoveryResetUploads = uploads.filter(
      (step) => step.with.surface === 'android-sso-recovery-reset',
    );
    expect(ssoRecoveryResetUploads).toHaveLength(1);
    expect(ssoRecoveryResetUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.sso-recovery-reset/**',
    });
    const messageAuthenticityShieldUploads = uploads.filter(
      (step) => step.with.surface === 'android-message-authenticity-shield',
    );
    expect(messageAuthenticityShieldUploads).toHaveLength(1);
    expect(messageAuthenticityShieldUploads[0]).toMatchObject({
      if: expect.stringMatching(
        /!cancelled\(\).*outputs\.message-authenticity-shield-started == 'true'/,
      ),
      with: {
        surface: 'android-message-authenticity-shield',
        shard: '${{ matrix.shard }}',
        'report-path':
          'dist/.playwright/trinity-e2e-android/*/android.message-authenticity-shield/**',
      },
    });
    const crossUserVerificationUploads = uploads.filter(
      (step) => step.with.surface === 'android-cross-user-verification',
    );
    expect(crossUserVerificationUploads).toHaveLength(1);
    expect(crossUserVerificationUploads[0]).toMatchObject({
      if: expect.stringMatching(
        /!cancelled\(\).*outputs\.cross-user-verification-started == 'true'/,
      ),
      with: {
        surface: 'android-cross-user-verification',
        shard: '${{ matrix.shard }}',
        'report-path':
          'dist/.playwright/trinity-e2e-android/*/android.cross-user-verification/**',
      },
    });
    expect(
      uploads.filter((step) => step.with.surface === 'android-recent-activity'),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-room-filter-spaceless',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-space-curation-create-join',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-space-room-order',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-room-http-error-recovery',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-room-settings-mobile',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-space-settings-mobile',
      ),
    ).toHaveLength(1);
    expect(
      uploads.filter(
        (step) => step.with.surface === 'android-space-settings-resilience',
      ),
    ).toHaveLength(1);
    const coreUploads = uploads.filter(
      (step) => step.with.surface === 'android-space-settings-core',
    );
    expect(coreUploads).toHaveLength(1);
    expect(coreUploads[0].with).toMatchObject({
      shard: '${{ matrix.shard }}',
      'report-path':
        'dist/.playwright/trinity-e2e-android/*/android.space-settings-core/**',
    });
    for (const step of uploads) {
      const gate =
        step.with.surface === 'android-runner-smoke'
          ? /!cancelled\(\).*outputs\.smoke-started == 'true'/
          : step.with.surface === 'android-critical-journeys'
            ? /!cancelled\(\).*outputs\.critical-started == 'true'/
            : step.with.surface === 'android-native-shell'
              ? /!cancelled\(\).*outputs\.native-shell-started == 'true'/
              : step.with.surface === 'android-accounts-workspace'
                ? /!cancelled\(\).*outputs\.accounts-started == 'true'/
                : step.with.surface === 'android-identity-presence'
                  ? /!cancelled\(\).*outputs\.identity-started == 'true'/
                  : step.with.surface === 'android-sidebar-filter'
                    ? /!cancelled\(\).*outputs\.sidebar-filter-started == 'true'/
                    : step.with.surface === 'android-sidebar-touch'
                      ? /!cancelled\(\).*outputs\.sidebar-touch-started == 'true'/
                      : step.with.surface === 'android-room-tags'
                        ? /!cancelled\(\).*outputs\.room-tags-started == 'true'/
                        : step.with.surface === 'android-room-read-state'
                          ? /!cancelled\(\).*outputs\.room-read-state-started == 'true'/
                          : step.with.surface === 'android-room-list'
                            ? /!cancelled\(\).*outputs\.room-list-started == 'true'/
                            : step.with.surface === 'android-unread-badges'
                              ? /!cancelled\(\).*outputs\.unread-badges-started == 'true'/
                              : step.with.surface === 'android-leave-room'
                                ? /!cancelled\(\).*outputs\.leave-room-started == 'true'/
                                : step.with.surface === 'android-space-leave'
                                  ? /!cancelled\(\).*outputs\.space-leave-started == 'true'/
                                  : step.with.surface ===
                                      'android-room-tombstone'
                                    ? /!cancelled\(\).*outputs\.room-tombstone-started == 'true'/
                                    : step.with.surface ===
                                        'android-message-moderation'
                                      ? /!cancelled\(\).*outputs\.message-moderation-started == 'true'/
                                      : step.with.surface ===
                                          'android-member-moderation'
                                        ? /!cancelled\(\).*outputs\.member-moderation-started == 'true'/
                                        : step.with.surface ===
                                            'android-member-details-promotion'
                                          ? /!cancelled\(\).*outputs\.member-details-promotion-started == 'true'/
                                          : step.with.surface ===
                                              'android-member-role-classification'
                                            ? /!cancelled\(\).*outputs\.member-role-classification-started == 'true'/
                                            : step.with.surface ===
                                                'android-member-role-live-updates'
                                              ? /!cancelled\(\).*outputs\.member-role-live-updates-started == 'true'/
                                              : step.with.surface ===
                                                  'android-room-unban'
                                                ? /!cancelled\(\).*outputs\.room-unban-started == 'true'/
                                                : step.with.surface ===
                                                    'android-room-roster-live-authority'
                                                  ? /!cancelled\(\).*outputs\.room-roster-live-authority-started == 'true'/
                                                  : step.with.surface ===
                                                      'android-room-address-lifecycle'
                                                    ? /!cancelled\(\).*outputs\.room-address-lifecycle-started == 'true'/
                                                    : step.with.surface ===
                                                        'android-room-access-policy'
                                                      ? /!cancelled\(\).*outputs\.room-access-policy-started == 'true'/
                                                      : step.with.surface ===
                                                          'android-room-profile-settings'
                                                        ? /!cancelled\(\).*outputs\.room-profile-settings-started == 'true'/
                                                        : step.with.surface ===
                                                            'android-room-for-you'
                                                          ? /!cancelled\(\).*outputs\.room-for-you-started == 'true'/
                                                          : step.with
                                                                .surface ===
                                                              'android-room-widget-settings'
                                                            ? /!cancelled\(\).*outputs\.room-widget-settings-started == 'true'/
                                                            : step.with
                                                                  .surface ===
                                                                'android-account-password-change'
                                                              ? /!cancelled\(\).*outputs\.account-password-change-started == 'true'/
                                                              : step.with
                                                                    .surface ===
                                                                  'android-clear-all-data'
                                                                ? /!cancelled\(\).*outputs\.clear-all-data-started == 'true'/
                                                                : step.with
                                                                      .surface ===
                                                                    'android-password-registration'
                                                                  ? /!cancelled\(\).*outputs\.password-registration-started == 'true'/
                                                                  : step.with
                                                                        .surface ===
                                                                      'android-legacy-sso'
                                                                    ? /!cancelled\(\).*outputs\.legacy-sso-started == 'true'/
                                                                    : step.with
                                                                          .surface ===
                                                                        'android-sso-recovery-reset'
                                                                      ? /!cancelled\(\).*outputs\.sso-recovery-reset-started == 'true'/
                                                                      : step
                                                                            .with
                                                                            .surface ===
                                                                          'android-message-authenticity-shield'
                                                                        ? /!cancelled\(\).*outputs\.message-authenticity-shield-started == 'true'/
                                                                        : step
                                                                              .with
                                                                              .surface ===
                                                                            'android-cross-user-verification'
                                                                          ? /!cancelled\(\).*outputs\.cross-user-verification-started == 'true'/
                                                                          : step
                                                                                .with
                                                                                .surface ===
                                                                              'android-composer-drafts'
                                                                            ? /!cancelled\(\).*outputs\.composer-drafts-started == 'true'/
                                                                            : step
                                                                                  .with
                                                                                  .surface ===
                                                                                'android-composer-formatting'
                                                                              ? /!cancelled\(\).*outputs\.composer-formatting-started == 'true'/
                                                                              : step
                                                                                    .with
                                                                                    .surface ===
                                                                                  'android-composer-mentions'
                                                                                ? /!cancelled\(\).*outputs\.composer-mentions-started == 'true'/
                                                                                : step
                                                                                      .with
                                                                                      .surface ===
                                                                                    'android-composer-reactions'
                                                                                  ? /!cancelled\(\).*outputs\.composer-reactions-started == 'true'/
                                                                                  : step
                                                                                        .with
                                                                                        .surface ===
                                                                                      'android-composer-typing'
                                                                                    ? /!cancelled\(\).*outputs\.composer-typing-started == 'true'/
                                                                                    : step
                                                                                          .with
                                                                                          .surface ===
                                                                                        'android-gif-picker'
                                                                                      ? /!cancelled\(\).*outputs\.gif-picker-started == 'true'/
                                                                                      : step
                                                                                            .with
                                                                                            .surface ===
                                                                                          'android-hide-system-messages'
                                                                                        ? /!cancelled\(\).*outputs\.hide-system-messages-started == 'true'/
                                                                                        : step
                                                                                              .with
                                                                                              .surface ===
                                                                                            'android-jump-to-date'
                                                                                          ? /!cancelled\(\).*outputs\.jump-to-date-started == 'true'/
                                                                                          : step
                                                                                                .with
                                                                                                .surface ===
                                                                                              'android-jump-to-latest'
                                                                                            ? /!cancelled\(\).*outputs\.jump-to-latest-started == 'true'/
                                                                                            : step
                                                                                                  .with
                                                                                                  .surface ===
                                                                                                'android-link-preview'
                                                                                              ? /!cancelled\(\).*outputs\.link-preview-started == 'true'/
                                                                                              : step
                                                                                                    .with
                                                                                                    .surface ===
                                                                                                  'android-location-share'
                                                                                                ? /!cancelled\(\).*outputs\.location-share-started == 'true'/
                                                                                                : step
                                                                                                      .with
                                                                                                      .surface ===
                                                                                                    'android-oidc-login'
                                                                                                  ? /!cancelled\(\).*outputs\.oidc-login-started == 'true'/
                                                                                                  : step
                                                                                                        .with
                                                                                                        .surface ===
                                                                                                      'android-security-settings'
                                                                                                    ? /!cancelled\(\).*outputs\.security-settings-started == 'true'/
                                                                                                    : step
                                                                                                          .with
                                                                                                          .surface ===
                                                                                                        'android-recovery-reset'
                                                                                                      ? /!cancelled\(\).*outputs\.recovery-reset-started == 'true'/
                                                                                                      : step
                                                                                                            .with
                                                                                                            .surface ===
                                                                                                          'android-recent-activity'
                                                                                                        ? /!cancelled\(\).*outputs\.recent-activity-started == 'true'/
                                                                                                        : step
                                                                                                              .with
                                                                                                              .surface ===
                                                                                                            'android-room-filter-spaceless'
                                                                                                          ? /!cancelled\(\).*outputs\.room-filter-spaceless-started == 'true'/
                                                                                                          : step
                                                                                                                .with
                                                                                                                .surface ===
                                                                                                              'android-space-curation-create-join'
                                                                                                            ? /!cancelled\(\).*outputs\.space-curation-create-join-started == 'true'/
                                                                                                            : step
                                                                                                                  .with
                                                                                                                  .surface ===
                                                                                                                'android-space-room-order'
                                                                                                              ? /!cancelled\(\).*outputs\.space-room-order-started == 'true'/
                                                                                                              : step
                                                                                                                    .with
                                                                                                                    .surface ===
                                                                                                                  'android-room-http-error-recovery'
                                                                                                                ? /!cancelled\(\).*outputs\.room-http-error-recovery-started == 'true'/
                                                                                                                : step
                                                                                                                      .with
                                                                                                                      .surface ===
                                                                                                                    'android-room-settings-mobile'
                                                                                                                  ? /!cancelled\(\).*outputs\.room-settings-mobile-started == 'true'/
                                                                                                                  : step
                                                                                                                        .with
                                                                                                                        .surface ===
                                                                                                                      'android-space-settings-mobile'
                                                                                                                    ? /!cancelled\(\).*outputs\.space-settings-mobile-started == 'true'/
                                                                                                                    : step
                                                                                                                          .with
                                                                                                                          .surface ===
                                                                                                                        'android-space-settings-resilience'
                                                                                                                      ? /!cancelled\(\).*outputs\.space-settings-resilience-started == 'true'/
                                                                                                                      : step
                                                                                                                            .with
                                                                                                                            .surface ===
                                                                                                                          'android-space-settings-core'
                                                                                                                        ? /!cancelled\(\).*outputs\.space-settings-core-started == 'true'/
                                                                                                                        : /!cancelled\(\).*outputs\.started == 'true'/;
      expect(step.if).toMatch(gate);
      expect(step.with.surface).toBeTruthy();
      expect(step.with['report-path']).toContain('dist/.playwright/');
    }
    const action = yaml(
      '.github/actions/upload-playwright-diagnostics/action.yml',
    );
    const upload = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    for (const field of [
      'github.run_id',
      'github.run_attempt',
      'github.sha',
      'github.job',
      'inputs.surface',
      'inputs.shard',
    ]) {
      expect(upload.with.name).toContain(field);
    }
  });

  it('runs composer typing through location-share consecutively on shard 2', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const lines = script.split('\n');
    const reactions = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:composer-reactions'),
    );
    const typing = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:composer-typing'),
    );
    const gifPicker = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:gif-picker'),
    );
    const hideSystemMessages = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:hide-system-messages'),
    );
    const jumpToDate = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:jump-to-date'),
    );
    const jumpToLatest = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:jump-to-latest'),
    );
    const linkPreview = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:link-preview'),
    );
    const locationShare = lines.findIndex((line) =>
      line.includes('trinity-e2e-android:location-share'),
    );
    const typingLine = lines[typing];
    const gifPickerLine = lines[gifPicker];
    const hideSystemMessagesLine = lines[hideSystemMessages];
    const jumpToDateLine = lines[jumpToDate];
    const jumpToLatestLine = lines[jumpToLatest];
    const linkPreviewLine = lines[linkPreview];
    const locationShareLine = lines[locationShare];

    expect(reactions).toBeGreaterThan(-1);
    expect(typing).toBe(reactions + 1);
    expect(typingLine).toContain('matrix.shard }}" = "2"');
    expect(typingLine).toContain('composer-typing-started=true');
    expect(typingLine).toContain('--timeout-ms 1500000');
    expect(gifPicker).toBe(typing + 1);
    expect(gifPickerLine).toContain('matrix.shard }}" = "2"');
    expect(gifPickerLine).toContain('gif-picker-started=true');
    expect(gifPickerLine).toContain('--timeout-ms 1500000');
    expect(hideSystemMessages).toBe(gifPicker + 1);
    expect(hideSystemMessagesLine).toContain('matrix.shard }}" = "2"');
    expect(hideSystemMessagesLine).toContain(
      'hide-system-messages-started=true',
    );
    expect(hideSystemMessagesLine).toContain('--timeout-ms 1500000');
    expect(jumpToDate).toBe(hideSystemMessages + 1);
    expect(jumpToDateLine).toContain('matrix.shard }}" = "2"');
    expect(jumpToDateLine).toContain('jump-to-date-started=true');
    expect(jumpToDateLine).toContain('--timeout-ms 1500000');
    expect(jumpToLatest).toBe(jumpToDate + 1);
    expect(jumpToLatestLine).toContain('matrix.shard }}" = "2"');
    expect(jumpToLatestLine).toContain('jump-to-latest-started=true');
    expect(jumpToLatestLine).toContain('--timeout-ms 1500000');
    expect(linkPreview).toBe(jumpToLatest + 1);
    expect(linkPreviewLine).toContain('matrix.shard }}" = "2"');
    expect(linkPreviewLine).toContain('link-preview-started=true');
    expect(linkPreviewLine).toContain('--timeout-ms 1500000');
    expect(locationShare).toBe(linkPreview + 1);
    expect(locationShareLine).toContain('matrix.shard }}" = "2"');
    expect(locationShareLine).toContain('location-share-started=true');
    expect(locationShareLine).toContain('--timeout-ms 1500000');
  });

  it('runs room HTTP recovery after space ordering and before retained Playwright on shard 1', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const filter = script.indexOf('trinity-e2e-android:sidebar-filter');
    const touch = script.indexOf('trinity-e2e-android:sidebar-touch');
    const roomTags = script.indexOf('trinity-e2e-android:room-tags');
    const readState = script.indexOf('trinity-e2e-android:room-read-state');
    const roomList = script.indexOf('trinity-e2e-android:room-list');
    const unreadBadges = script.indexOf('trinity-e2e-android:unread-badges');
    const leaveRoom = script.indexOf('trinity-e2e-android:leave-room');
    const recentActivity = script.indexOf(
      'trinity-e2e-android:recent-activity',
    );
    const roomFilterSpaceless = script.indexOf(
      'trinity-e2e-android:room-filter-spaceless',
    );
    const spaceCurationCreateJoin = script.indexOf(
      'trinity-e2e-android:space-curation-create-join',
    );
    const spaceRoomOrder = script.indexOf(
      'trinity-e2e-android:space-room-order',
    );
    const roomHttpErrorRecovery = script.indexOf(
      'trinity-e2e-android:room-http-error-recovery',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const spaceRoomOrderLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:space-room-order'));
    const roomHttpErrorRecoveryLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-http-error-recovery'),
      );

    expect(filter).toBeGreaterThan(-1);
    expect(touch).toBeGreaterThan(filter);
    expect(roomTags).toBeGreaterThan(touch);
    expect(readState).toBeGreaterThan(roomTags);
    expect(roomList).toBeGreaterThan(readState);
    expect(unreadBadges).toBeGreaterThan(roomList);
    expect(leaveRoom).toBeGreaterThan(unreadBadges);
    expect(recentActivity).toBeGreaterThan(leaveRoom);
    expect(roomFilterSpaceless).toBeGreaterThan(recentActivity);
    expect(spaceCurationCreateJoin).toBeGreaterThan(roomFilterSpaceless);
    expect(spaceRoomOrder).toBeGreaterThan(spaceCurationCreateJoin);
    expect(roomHttpErrorRecovery).toBeGreaterThan(spaceRoomOrder);
    expect(playwright).toBeGreaterThan(roomHttpErrorRecovery);
    expect(spaceRoomOrderLine).toContain('matrix.shard }}" = "1"');
    expect(spaceRoomOrderLine).toContain('space-room-order-started=true');
    expect(roomHttpErrorRecoveryLine).toContain('matrix.shard }}" = "1"');
    expect(roomHttpErrorRecoveryLine).toContain(
      'room-http-error-recovery-started=true',
    );
  });

  it('runs mobile Room Settings after identity and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const identity = script.indexOf('trinity-e2e-android:identity-presence');
    const roomSettings = script.indexOf(
      'trinity-e2e-android:room-settings-mobile',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const roomSettingsLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-settings-mobile'),
      );

    expect(identity).toBeGreaterThan(-1);
    expect(roomSettings).toBeGreaterThan(identity);
    expect(playwright).toBeGreaterThan(roomSettings);
    expect(roomSettingsLine).toContain('matrix.shard }}" = "4"');
    expect(roomSettingsLine).toContain('room-settings-mobile-started=true');
  });

  it('runs mobile Space Settings after mobile Room Settings and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomSettings = script.indexOf(
      'trinity-e2e-android:room-settings-mobile',
    );
    const spaceSettings = script.indexOf(
      'trinity-e2e-android:space-settings-mobile',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    expect(spaceSettings).toBeGreaterThan(roomSettings);
    expect(playwright).toBeGreaterThan(spaceSettings);
  });

  it('runs Space Settings resilience after mobile Space Settings and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const mobile = script.indexOf('trinity-e2e-android:space-settings-mobile');
    const resilience = script.indexOf(
      'trinity-e2e-android:space-settings-resilience',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    expect(resilience).toBeGreaterThan(mobile);
    expect(playwright).toBeGreaterThan(resilience);
  });

  it('runs Room tombstone after Space leave and before retained Playwright on shard 2', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const nativeShell = script.indexOf('trinity-e2e-android:native-shell');
    const core = script.indexOf('trinity-e2e-android:space-settings-core');
    const spaceLeave = script.indexOf('trinity-e2e-android:space-leave');
    const roomTombstone = script.indexOf('trinity-e2e-android:room-tombstone');
    const playwright = script.indexOf('pnpm e2e:android --');
    const coreLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:space-settings-core'));
    const spaceLeaveLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:space-leave'));
    const roomTombstoneLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:room-tombstone'));

    expect(nativeShell).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(nativeShell);
    expect(spaceLeave).toBeGreaterThan(core);
    expect(roomTombstone).toBeGreaterThan(spaceLeave);
    expect(playwright).toBeGreaterThan(roomTombstone);
    expect(coreLine).toContain('matrix.shard }}" = "2"');
    expect(coreLine).toContain('space-settings-core-started=true');
    expect(coreLine).toContain('--timeout-ms 2700000');
    expect(spaceLeaveLine).toContain('matrix.shard }}" = "2"');
    expect(spaceLeaveLine).toContain('space-leave-started=true');
    expect(spaceLeaveLine).toContain('--timeout-ms 1200000');
    expect(roomTombstoneLine).toContain('matrix.shard }}" = "2"');
    expect(roomTombstoneLine).toContain('room-tombstone-started=true');
    expect(roomTombstoneLine).toContain('--timeout-ms 1200000');
  });

  it('runs cross-user verification before unrelated shard 2 suites can suppress its evidence', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const legacySso = script.indexOf('trinity-e2e-android:legacy-sso');
    const ssoRecoveryReset = script.indexOf(
      'trinity-e2e-android:sso-recovery-reset',
    );
    const messageAuthenticityShield = script.indexOf(
      'trinity-e2e-android:message-authenticity-shield',
    );
    const crossUserVerification = script.indexOf(
      'trinity-e2e-android:cross-user-verification',
    );
    const nativeShell = script.indexOf('trinity-e2e-android:native-shell');
    const messageAuthenticityShieldLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:message-authenticity-shield'),
      );
    const crossUserVerificationLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:cross-user-verification'),
      );

    expect(crossUserVerification).toBeGreaterThan(-1);
    expect(legacySso).toBeGreaterThan(crossUserVerification);
    expect(ssoRecoveryReset).toBeGreaterThan(legacySso);
    expect(messageAuthenticityShield).toBeGreaterThan(ssoRecoveryReset);
    expect(nativeShell).toBeGreaterThan(messageAuthenticityShield);
    expect(messageAuthenticityShieldLine).toContain('matrix.shard }}" = "2"');
    expect(messageAuthenticityShieldLine).toContain(
      'message-authenticity-shield-started=true',
    );
    expect(messageAuthenticityShieldLine).toContain('--timeout-ms 2100000');
    expect(crossUserVerificationLine).toContain('matrix.shard }}" = "2"');
    expect(crossUserVerificationLine).toContain(
      'cross-user-verification-started=true',
    );
    expect(crossUserVerificationLine).toContain('--timeout-ms 2100000');
  });

  it('runs member details and promotion after Room tombstone and before retained Playwright on shard 2', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomTombstone = script.indexOf('trinity-e2e-android:room-tombstone');
    const memberDetailsPromotion = script.indexOf(
      'trinity-e2e-android:member-details-promotion',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const memberDetailsPromotionLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:member-details-promotion'),
      );

    expect(roomTombstone).toBeGreaterThan(-1);
    expect(memberDetailsPromotion).toBeGreaterThan(roomTombstone);
    expect(playwright).toBeGreaterThan(memberDetailsPromotion);
    expect(memberDetailsPromotionLine).toContain('matrix.shard }}" = "2"');
    expect(memberDetailsPromotionLine).toContain(
      'member-details-promotion-started=true',
    );
    expect(memberDetailsPromotionLine).toContain('--timeout-ms 1500000');
  });

  it('runs member role classification after member details and promotion and before retained Playwright on shard 2', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const memberDetailsPromotion = script.indexOf(
      'trinity-e2e-android:member-details-promotion',
    );
    const memberRoleClassification = script.indexOf(
      'trinity-e2e-android:member-role-classification',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const memberRoleClassificationLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:member-role-classification'),
      );

    expect(memberDetailsPromotion).toBeGreaterThan(-1);
    expect(memberRoleClassification).toBeGreaterThan(memberDetailsPromotion);
    expect(playwright).toBeGreaterThan(memberRoleClassification);
    expect(memberRoleClassificationLine).toContain('matrix.shard }}" = "2"');
    expect(memberRoleClassificationLine).toContain(
      'member-role-classification-started=true',
    );
    expect(memberRoleClassificationLine).toContain('--timeout-ms 2100000');
  });

  it('runs member role live updates after Space Settings resilience and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const spaceSettingsResilience = script.indexOf(
      'trinity-e2e-android:space-settings-resilience',
    );
    const memberRoleLiveUpdates = script.indexOf(
      'trinity-e2e-android:member-role-live-updates',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const memberRoleLiveUpdatesLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:member-role-live-updates'),
      );

    expect(spaceSettingsResilience).toBeGreaterThan(-1);
    expect(memberRoleLiveUpdates).toBeGreaterThan(spaceSettingsResilience);
    expect(playwright).toBeGreaterThan(memberRoleLiveUpdates);
    expect(memberRoleLiveUpdatesLine).toContain('matrix.shard }}" = "4"');
    expect(memberRoleLiveUpdatesLine).toContain(
      'member-role-live-updates-started=true',
    );
    expect(memberRoleLiveUpdatesLine).toContain('--timeout-ms 2100000');
  });

  it('runs Room widget settings after live authority updates and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const liveUpdates = script.indexOf(
      'trinity-e2e-android:member-role-live-updates',
    );
    const widgets = script.indexOf('trinity-e2e-android:room-widget-settings');
    const playwright = script.indexOf('pnpm e2e:android --');
    const widgetsLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-widget-settings'),
      );

    expect(widgets).toBeGreaterThan(liveUpdates);
    expect(playwright).toBeGreaterThan(widgets);
    expect(widgetsLine).toContain('matrix.shard }}" = "4"');
    expect(widgetsLine).toContain('room-widget-settings-started=true');
    expect(widgetsLine).toContain('--timeout-ms 2700000');
  });

  it('runs account password change after Room widgets and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const widgets = script.indexOf('trinity-e2e-android:room-widget-settings');
    const passwordChange = script.indexOf(
      'trinity-e2e-android:account-password-change',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const passwordChangeLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:account-password-change'),
      );

    expect(passwordChange).toBeGreaterThan(widgets);
    expect(playwright).toBeGreaterThan(passwordChange);
    expect(passwordChangeLine).toContain('matrix.shard }}" = "4"');
    expect(passwordChangeLine).toContain(
      'account-password-change-started=true',
    );
    expect(passwordChangeLine).toContain('--timeout-ms 1200000');
  });

  it('runs clear all data after password change and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const passwordChange = script.indexOf(
      'trinity-e2e-android:account-password-change',
    );
    const clearAllData = script.indexOf('trinity-e2e-android:clear-all-data');
    const playwright = script.indexOf('pnpm e2e:android --');
    const clearAllDataLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:clear-all-data'));

    expect(clearAllData).toBeGreaterThan(passwordChange);
    expect(playwright).toBeGreaterThan(clearAllData);
    expect(clearAllDataLine).toContain('matrix.shard }}" = "4"');
    expect(clearAllDataLine).toContain('clear-all-data-started=true');
    expect(clearAllDataLine).toContain('--timeout-ms 1500000');
  });

  it('runs password registration after clear all data and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const clearAllData = script.indexOf('trinity-e2e-android:clear-all-data');
    const registration = script.indexOf(
      'trinity-e2e-android:password-registration',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const registrationLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:password-registration'),
      );

    expect(registration).toBeGreaterThan(clearAllData);
    expect(playwright).toBeGreaterThan(registration);
    expect(registrationLine).toContain('matrix.shard }}" = "4"');
    expect(registrationLine).toContain('password-registration-started=true');
    expect(registrationLine).toContain('--timeout-ms 1200000');
  });

  it('runs OIDC login after password registration and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const registration = script.indexOf(
      'trinity-e2e-android:password-registration',
    );
    const oidcLogin = script.indexOf('trinity-e2e-android:oidc-login');
    const playwright = script.indexOf('pnpm e2e:android --');
    const oidcLoginLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:oidc-login'));

    expect(oidcLogin).toBeGreaterThan(registration);
    expect(playwright).toBeGreaterThan(oidcLogin);
    expect(oidcLoginLine).toContain('matrix.shard }}" = "4"');
    expect(oidcLoginLine).toContain('oidc-login-started=true');
    expect(oidcLoginLine).toContain('--timeout-ms 1500000');
  });

  it('runs Security settings after OIDC and before retained Playwright on shard 4', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const oidcLogin = script.indexOf('trinity-e2e-android:oidc-login');
    const securitySettings = script.indexOf(
      'trinity-e2e-android:security-settings',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const securitySettingsLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:security-settings'));

    expect(securitySettings).toBeGreaterThan(oidcLogin);
    expect(playwright).toBeGreaterThan(securitySettings);
    expect(securitySettingsLine).toContain('matrix.shard }}" = "4"');
    expect(securitySettingsLine).toContain('security-settings-started=true');
    expect(securitySettingsLine).toContain('--timeout-ms 1200000');
  });

  it('runs recovery reset immediately after smoke and before other shard 4 suites', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const runnerSmoke = script.indexOf('trinity-e2e-android:runner-smoke');
    const recoveryReset = script.indexOf('trinity-e2e-android:recovery-reset');
    const identity = script.indexOf('trinity-e2e-android:identity-presence');
    const playwright = script.indexOf('pnpm e2e:android --');
    const recoveryResetLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:recovery-reset'));

    expect(runnerSmoke).toBeGreaterThan(-1);
    expect(recoveryReset).toBeGreaterThan(runnerSmoke);
    expect(identity).toBeGreaterThan(recoveryReset);
    expect(playwright).toBeGreaterThan(recoveryReset);
    expect(recoveryResetLine).toContain('matrix.shard }}" = "4"');
    expect(recoveryResetLine).toContain('recovery-reset-started=true');
    expect(recoveryResetLine).toContain('--timeout-ms 3000000');
  });

  it('runs message moderation after Accounts and before retained Playwright on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const accounts = script.indexOf('trinity-e2e-android:accounts-workspace');
    const moderation = script.indexOf('trinity-e2e-android:message-moderation');
    const playwright = script.indexOf('pnpm e2e:android --');
    const moderationLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:message-moderation'));

    expect(accounts).toBeGreaterThan(-1);
    expect(moderation).toBeGreaterThan(accounts);
    expect(playwright).toBeGreaterThan(moderation);
    expect(moderationLine).toContain('matrix.shard }}" = "3"');
    expect(moderationLine).toContain('message-moderation-started=true');
    expect(moderationLine).toContain('--timeout-ms 1500000');
  });

  it('runs member moderation after message moderation and before retained Playwright on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const messageModeration = script.indexOf(
      'trinity-e2e-android:message-moderation',
    );
    const memberModeration = script.indexOf(
      'trinity-e2e-android:member-moderation',
    );
    const playwright = script.indexOf('pnpm e2e:android --');
    const memberModerationLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:member-moderation'));

    expect(messageModeration).toBeGreaterThan(-1);
    expect(memberModeration).toBeGreaterThan(messageModeration);
    expect(playwright).toBeGreaterThan(memberModeration);
    expect(memberModerationLine).toContain('matrix.shard }}" = "3"');
    expect(memberModerationLine).toContain('member-moderation-started=true');
    expect(memberModerationLine).toContain('--timeout-ms 1800000');
  });

  it('runs Room unban after message moderation and before member moderation on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const messageModeration = script.indexOf(
      'trinity-e2e-android:message-moderation',
    );
    const memberModeration = script.indexOf(
      'trinity-e2e-android:member-moderation',
    );
    const roomUnban = script.indexOf('trinity-e2e-android:room-unban');
    const roomUnbanLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:room-unban'));

    expect(messageModeration).toBeGreaterThan(-1);
    expect(roomUnban).toBeGreaterThan(messageModeration);
    expect(memberModeration).toBeGreaterThan(roomUnban);
    expect(roomUnbanLine).toContain('matrix.shard }}" = "3"');
    expect(roomUnbanLine).toContain('room-unban-started=true');
    expect(roomUnbanLine).toContain('--timeout-ms 900000');
  });

  it('runs Room roster live authority after Room unban and before member moderation on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomUnban = script.indexOf('trinity-e2e-android:room-unban');
    const roomRosterLiveAuthority = script.indexOf(
      'trinity-e2e-android:room-roster-live-authority',
    );
    const memberModeration = script.indexOf(
      'trinity-e2e-android:member-moderation',
    );
    const roomRosterLiveAuthorityLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-roster-live-authority'),
      );

    expect(roomUnban).toBeGreaterThan(-1);
    expect(roomRosterLiveAuthority).toBeGreaterThan(roomUnban);
    expect(memberModeration).toBeGreaterThan(roomRosterLiveAuthority);
    expect(roomRosterLiveAuthorityLine).toContain('matrix.shard }}" = "3"');
    expect(roomRosterLiveAuthorityLine).toContain(
      'room-roster-live-authority-started=true',
    );
    expect(roomRosterLiveAuthorityLine).toContain('--timeout-ms 2100000');
  });

  it('runs Room address lifecycle after Room roster and before member moderation on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomRosterLiveAuthority = script.indexOf(
      'trinity-e2e-android:room-roster-live-authority',
    );
    const roomAddressLifecycle = script.indexOf(
      'trinity-e2e-android:room-address-lifecycle',
    );
    const memberModeration = script.indexOf(
      'trinity-e2e-android:member-moderation',
    );
    const roomAddressLifecycleLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-address-lifecycle'),
      );

    expect(roomRosterLiveAuthority).toBeGreaterThan(-1);
    expect(roomAddressLifecycle).toBeGreaterThan(roomRosterLiveAuthority);
    expect(memberModeration).toBeGreaterThan(roomAddressLifecycle);
    expect(roomAddressLifecycleLine).toContain('matrix.shard }}" = "3"');
    expect(roomAddressLifecycleLine).toContain(
      'room-address-lifecycle-started=true',
    );
    expect(roomAddressLifecycleLine).toContain('--timeout-ms 900000');
  });

  it('runs Room access policy before Accounts on shard 3 so predecessor failures cannot suppress its evidence', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomAccessPolicy = script.indexOf(
      'trinity-e2e-android:room-access-policy',
    );
    const accountsWorkspace = script.indexOf(
      'trinity-e2e-android:accounts-workspace',
    );
    const roomAccessPolicyLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:room-access-policy'));

    expect(roomAccessPolicy).toBeGreaterThan(-1);
    expect(accountsWorkspace).toBeGreaterThan(roomAccessPolicy);
    expect(roomAccessPolicyLine).toContain('matrix.shard }}" = "3"');
    expect(roomAccessPolicyLine).toContain('room-access-policy-started=true');
    expect(roomAccessPolicyLine).toContain('--timeout-ms 2400000');
  });

  it('runs Room profile settings after Room access policy and before Accounts on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomAccessPolicy = script.indexOf(
      'trinity-e2e-android:room-access-policy',
    );
    const roomProfileSettings = script.indexOf(
      'trinity-e2e-android:room-profile-settings',
    );
    const accountsWorkspace = script.indexOf(
      'trinity-e2e-android:accounts-workspace',
    );
    const roomProfileSettingsLine = script
      .split('\n')
      .find((line) =>
        line.includes('trinity-e2e-android:room-profile-settings'),
      );

    expect(roomProfileSettings).toBeGreaterThan(roomAccessPolicy);
    expect(accountsWorkspace).toBeGreaterThan(roomProfileSettings);
    expect(roomProfileSettingsLine).toContain('matrix.shard }}" = "3"');
    expect(roomProfileSettingsLine).toContain(
      'room-profile-settings-started=true',
    );
    expect(roomProfileSettingsLine).toContain('--timeout-ms 2400000');
  });

  it('runs Room For-you after Room profile settings and before Accounts on shard 3', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const roomProfileSettings = script.indexOf(
      'trinity-e2e-android:room-profile-settings',
    );
    const roomForYou = script.indexOf('trinity-e2e-android:room-for-you');
    const accountsWorkspace = script.indexOf(
      'trinity-e2e-android:accounts-workspace',
    );
    const roomForYouLine = script
      .split('\n')
      .find((line) => line.includes('trinity-e2e-android:room-for-you'));

    expect(roomForYou).toBeGreaterThan(roomProfileSettings);
    expect(accountsWorkspace).toBeGreaterThan(roomForYou);
    expect(roomForYouLine).toContain('matrix.shard }}" = "3"');
    expect(roomForYouLine).toContain('room-for-you-started=true');
    expect(roomForYouLine).toContain('--timeout-ms 2100000');
  });

  it('waits for KVM udev completion and separates browser and Gradle caches', () => {
    const steps = workflow.jobs['android-e2e'].steps;
    const kvm = steps.find(
      (step) => step.name === 'Grant emulator access to KVM',
    ).run;
    expect(kvm.indexOf('udevadm settle --timeout=30')).toBeGreaterThan(
      kvm.indexOf('udevadm trigger'),
    );
    expect(kvm.indexOf('test -r /dev/kvm')).toBeGreaterThan(
      kvm.indexOf('udevadm settle'),
    );
    const caches = steps.filter((step) =>
      step.uses?.startsWith('actions/cache@'),
    );
    expect(
      caches.some(
        (step) =>
          step.with.path.includes('.gradle') &&
          !step.with.path.includes('ms-playwright'),
      ),
    ).toBe(true);
    expect(
      caches.some(
        (step) =>
          step.with.path.includes('ms-playwright') &&
          !step.with.path.includes('.gradle'),
      ),
    ).toBe(true);
  });

  it('keeps Android animations enabled for installed-WebView motion contracts', () => {
    const emulator = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    );

    expect(emulator.with['disable-animations']).toBe(false);
  });

  it('installs the pinned Chrome fixture runtime only for the legacy SSO shard', () => {
    const steps = workflow.jobs['android-e2e'].steps;
    const chrome = steps.find(
      (step) => step.name === 'Install pinned Chrome fixture prerequisite',
    );
    const emulator = steps.findIndex((step) => step.id === 'android');

    expect(chrome).toBeDefined();
    expect(chrome.if).toBe('${{ matrix.shard == 2 }}');
    expect(chrome.run).toBe(
      'node scripts/ci-runner-prerequisites.mjs chromium',
    );
    expect(steps.indexOf(chrome)).toBeLessThan(emulator);
  });

  it('keeps emulator-runner script commands valid as standalone shell lines', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const lines = script
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replaceAll('${{ matrix.shard }}', '1'));

    expect(lines).toHaveLength(59);
    for (const line of lines) {
      expect(() => execFileSync('sh', ['-n', '-c', line])).not.toThrow();
    }
  });
});
