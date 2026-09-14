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
      '${{ matrix.shard == 3 && 180 || 120 }}',
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
    expect(uploads.length).toBe(36);
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
                                              'android-recent-activity'
                                            ? /!cancelled\(\).*outputs\.recent-activity-started == 'true'/
                                            : step.with.surface ===
                                                'android-room-filter-spaceless'
                                              ? /!cancelled\(\).*outputs\.room-filter-spaceless-started == 'true'/
                                              : step.with.surface ===
                                                  'android-space-curation-create-join'
                                                ? /!cancelled\(\).*outputs\.space-curation-create-join-started == 'true'/
                                                : step.with.surface ===
                                                    'android-space-room-order'
                                                  ? /!cancelled\(\).*outputs\.space-room-order-started == 'true'/
                                                  : step.with.surface ===
                                                      'android-room-http-error-recovery'
                                                    ? /!cancelled\(\).*outputs\.room-http-error-recovery-started == 'true'/
                                                    : step.with.surface ===
                                                        'android-room-settings-mobile'
                                                      ? /!cancelled\(\).*outputs\.room-settings-mobile-started == 'true'/
                                                      : step.with.surface ===
                                                          'android-space-settings-mobile'
                                                        ? /!cancelled\(\).*outputs\.space-settings-mobile-started == 'true'/
                                                        : step.with.surface ===
                                                            'android-space-settings-resilience'
                                                          ? /!cancelled\(\).*outputs\.space-settings-resilience-started == 'true'/
                                                          : step.with
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

  it('keeps emulator-runner script commands valid as standalone shell lines', () => {
    const script = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with.script;
    const lines = script
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replaceAll('${{ matrix.shard }}', '1'));

    expect(lines).toHaveLength(29);
    for (const line of lines) {
      expect(() => execFileSync('sh', ['-n', '-c', line])).not.toThrow();
    }
  });
});
