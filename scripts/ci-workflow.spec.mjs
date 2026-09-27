/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { CODE_JOB_IDS } from './ci-classify.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const workflow = yaml('.github/workflows/ci.yml');

// Each native Android suite's own CI placement: [target, shard, started flag, command
// timeout]. Order within a shard is scheduling, not a suite contract.
const ANDROID_NATIVE_PLACEMENT = [
  // Runner smoke proves the emulator runner once, on shard 1; other shards start
  // with their first suite.
  ['runner-smoke', 1, 'smoke', 1_200_000],
  ['critical-journeys', 1, 'critical', 1_200_000],
  ['leave-room', 1, 'leave-room', 1_200_000],
  ['message-linkify', 1, 'message-linkify', 1_200_000],
  ['message-poll', 1, 'message-poll', 1_500_000],
  ['recent-activity', 1, 'recent-activity', 1_200_000],
  ['room-filter-spaceless', 1, 'room-filter-spaceless', 1_200_000],
  ['room-for-you', 1, 'room-for-you', 2_100_000],
  ['room-http-error-recovery', 1, 'room-http-error-recovery', 1_200_000],
  ['room-list', 1, 'room-list', 1_200_000],
  ['room-read-state', 1, 'room-read-state', 1_200_000],
  ['room-tags', 1, 'room-tags', 1_200_000],
  ['sidebar-filter', 1, 'sidebar-filter', 1_200_000],
  ['sidebar-touch', 1, 'sidebar-touch', 1_200_000],
  ['space-curation-create-join', 1, 'space-curation-create-join', 1_200_000],
  ['space-room-order', 1, 'space-room-order', 1_200_000],
  ['space-settings-mobile', 1, 'space-settings-mobile', 1_500_000],
  ['unread-badges', 1, 'unread-badges', 1_200_000],
  ['composer-drafts', 2, 'composer-drafts', 1_500_000],
  ['composer-formatting', 2, 'composer-formatting', 1_500_000],
  ['composer-mentions', 2, 'composer-mentions', 1_200_000],
  ['composer-reactions', 2, 'composer-reactions', 1_200_000],
  ['composer-typing', 2, 'composer-typing', 1_500_000],
  ['cross-user-verification', 2, 'cross-user-verification', 2_100_000],
  ['edit-history', 2, 'edit-history', 2_700_000],
  ['member-moderation', 2, 'member-moderation', 1_800_000],
  ['member-role-live-updates', 2, 'member-role-live-updates', 2_100_000],
  ['message-forward', 2, 'message-forward', 1_500_000],
  ['message-grouping', 2, 'message-grouping', 1_500_000],
  ['accounts-workspace', 3, 'accounts', 5_100_000],
  ['message-moderation', 3, 'message-moderation', 1_500_000],
  ['message-receipts', 3, 'message-receipts', 1_200_000],
  ['message-source', 3, 'message-source', 1_200_000],
  ['message-spoiler', 3, 'message-spoiler', 1_200_000],
  ['room-access-policy', 3, 'room-access-policy', 2_400_000],
  ['room-address-lifecycle', 3, 'room-address-lifecycle', 900_000],
  ['room-profile-settings', 3, 'room-profile-settings', 2_400_000],
  ['room-roster-live-authority', 3, 'room-roster-live-authority', 2_100_000],
  ['room-unban', 3, 'room-unban', 900_000],
  ['account-password-change', 4, 'account-password-change', 1_200_000],
  ['clear-all-data', 4, 'clear-all-data', 1_500_000],
  ['identity-presence', 4, 'identity', 1_200_000],
  ['message-links', 4, 'message-links', 3_300_000],
  ['oidc-login', 4, 'oidc-login', 1_500_000],
  ['password-registration', 4, 'password-registration', 1_200_000],
  ['recovery-reset', 4, 'recovery-reset', 3_000_000],
  ['room-settings-mobile', 4, 'room-settings-mobile', 1_200_000],
  ['security-settings', 4, 'security-settings', 1_200_000],
  ['gif-picker', 5, 'gif-picker', 1_500_000],
  ['hide-system-messages', 5, 'hide-system-messages', 1_500_000],
  ['jump-to-date', 5, 'jump-to-date', 1_500_000],
  ['jump-to-latest', 5, 'jump-to-latest', 1_500_000],
  ['legacy-sso', 5, 'legacy-sso', 1_500_000],
  ['link-preview', 5, 'link-preview', 1_500_000],
  ['location-share', 5, 'location-share', 1_500_000],
  ['media-retention', 5, 'media-retention', 1_500_000],
  ['message-action-sheet', 5, 'message-action-sheet', 3_300_000],
  ['message-markdown', 5, 'message-markdown', 2_100_000],
  ['space-settings-resilience', 5, 'space-settings-resilience', 1_500_000],
  ['sso-recovery-reset', 5, 'sso-recovery-reset', 1_500_000],
  ['member-details-promotion', 6, 'member-details-promotion', 1_500_000],
  ['member-role-classification', 6, 'member-role-classification', 2_100_000],
  ['message-authenticity-shield', 6, 'message-authenticity-shield', 2_100_000],
  ['message-quote', 6, 'message-quote', 1_800_000],
  ['native-shell', 6, 'native-shell', 1_200_000],
  ['room-tombstone', 6, 'room-tombstone', 1_200_000],
  ['room-widget-settings', 6, 'room-widget-settings', 2_700_000],
  ['space-leave', 6, 'space-leave', 1_200_000],
  ['space-settings-core', 6, 'space-settings-core', 2_700_000],
];

describe('CI execution contract', () => {
  it('sizes the Android emulator so its adb connection survives app load', () => {
    // The action's 2-core default dropped the emulator's adb connection under
    // app, WebView and Chrome load, removing every port forward mid-suite.
    const emulator = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'android',
    ).with;
    expect(Number(emulator.cores)).toBeGreaterThanOrEqual(4);
    expect(Number.parseInt(emulator['ram-size'], 10)).toBeGreaterThanOrEqual(
      4096,
    );
    expect(emulator['ram-size']).toMatch(/^\d+M$/u);
  });

  it('gates message-grouping upload on its exact regular-file safety marker', () => {
    const gate = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'message-grouping-artifact-gate',
    );
    expect(gate.if).toContain(
      "steps.android.outputs.message-grouping-started == 'true'",
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'trinity-grouping-gate-'));
    try {
      const reports = join(tempRoot, 'reports');
      const output = join(tempRoot, 'github-output');
      const wrong = join(reports, 'run-1', 'android.message-grouping', 'other');
      mkdirSync(wrong, { recursive: true });
      writeFileSync(join(wrong, 'publication-safe'), 'scanned\n');
      writeFileSync(output, '');
      const runGate = () =>
        execFileSync('/bin/bash', ['-e', '-c', gate.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            MESSAGE_GROUPING_DIAGNOSTIC_ROOT: reports,
            GITHUB_OUTPUT: output,
          },
        });
      runGate();
      expect(readFileSync(output, 'utf8')).toBe('');
      const exact = join(
        reports,
        'run-1',
        'android.message-grouping',
        'message-grouping',
      );
      mkdirSync(exact, { recursive: true });
      writeFileSync(join(exact, 'publication-safe'), 'scanned\n');
      runGate();
      expect(readFileSync(output, 'utf8')).toBe('message-grouping-safe=true\n');
      const upload = workflow.jobs['android-e2e'].steps.find(
        (step) => step.with?.surface === 'android-message-grouping',
      );
      expect(upload.if).toContain(
        "steps.android.outputs.message-grouping-started == 'true'",
      );
      expect(upload.if).toContain(
        "steps.message-grouping-artifact-gate.outputs.message-grouping-safe == 'true'",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('publishes edit-history diagnostics only for the exact safe marker without rg on PATH', () => {
    const gate = workflow.jobs['android-e2e'].steps.find(
      (step) => step.id === 'edit-history-artifact-gate',
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'trinity-edit-history-gate-'));
    try {
      const bin = join(tempRoot, 'bin');
      const reports = join(tempRoot, 'reports');
      const output = join(tempRoot, 'github-output');
      mkdirSync(bin);
      const findBinary = execFileSync('/bin/sh', ['-c', 'command -v find'], {
        encoding: 'utf8',
      }).trim();
      symlinkSync(findBinary, join(bin, 'find'));
      mkdirSync(join(reports, 'run-1', 'android.edit-history', 'unrelated'), {
        recursive: true,
      });
      writeFileSync(
        join(
          reports,
          'run-1',
          'android.edit-history',
          'unrelated',
          'publication-safe',
        ),
        '',
      );
      writeFileSync(output, '');
      const runGate = () =>
        execFileSync('/bin/bash', ['-e', '-c', gate.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: bin,
            EDIT_HISTORY_DIAGNOSTIC_ROOT: reports,
            GITHUB_OUTPUT: output,
          },
        });

      runGate();
      expect(readFileSync(output, 'utf8')).toBe('');

      const exactDirectory = join(
        reports,
        'run-1',
        'android.edit-history',
        'edit-history',
      );
      mkdirSync(exactDirectory, { recursive: true });
      const exactMarker = join(exactDirectory, 'publication-safe');
      symlinkSync(
        join(
          reports,
          'run-1',
          'android.edit-history',
          'unrelated',
          'publication-safe',
        ),
        exactMarker,
      );
      runGate();
      expect(readFileSync(output, 'utf8')).toBe('');

      rmSync(exactMarker);
      const linkedReport = join(tempRoot, 'linked-report');
      mkdirSync(join(linkedReport, 'android.edit-history', 'edit-history'), {
        recursive: true,
      });
      writeFileSync(
        join(
          linkedReport,
          'android.edit-history',
          'edit-history',
          'publication-safe',
        ),
        '',
      );
      symlinkSync(linkedReport, join(reports, 'run-link'));
      runGate();
      expect(readFileSync(output, 'utf8')).toBe('');

      writeFileSync(exactMarker, '');
      runGate();
      expect(readFileSync(output, 'utf8')).toBe('edit-history-safe=true\n');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('gives shard 1 its measured native prefix, retained Playwright budget, and diagnostics time', () => {
    const job = workflow.jobs['android-e2e'];
    const expression = job['timeout-minutes'];
    const shardOneMinutes = Number(
      expression.match(/matrix\.shard == 1 && (\d+)/)?.[1] ??
        expression.match(/\|\| (\d+) \}\}$/)?.[1],
    );
    const script = job.steps.find((step) => step.id === 'android').with.script;
    const retained = script
      .split('\n')
      .find((line) => line.includes('pnpm e2e:android --'));
    const retainedMinutes =
      Number(retained.match(/--timeout-ms (\d+)/)?.[1]) / 60_000;
    // Run 35699645053 exceeded 120 minutes. In run 35753147455, shard 1
    // started at 16:19:06 and reached retained Playwright at 17:57:33.
    const observedPrefixMinutes = 99;
    const diagnosticsMinutes = 15;
    expect(retainedMinutes).toBe(45);
    expect(shardOneMinutes).toBeGreaterThanOrEqual(
      observedPrefixMinutes + retainedMinutes + diagnosticsMinutes,
    );
    expect(shardOneMinutes).toBeLessThanOrEqual(180);
    expect(job['continue-on-error']).toBeUndefined();
  });

  it('lets the complete Storybook matrix finish within a bounded command budget', () => {
    const job = workflow.jobs.e2e;
    const storybook = job.steps.find((step) => step.id === 'storybook');
    const timeoutMs = Number(storybook.run.match(/--timeout-ms (\d+)/)?.[1]);
    // Original run 35753147455: 157/163 passed by the old 10-minute deadline.
    // Keep room for all six remaining 30-second tests and lifecycle teardown.
    const observedElapsedMs = 600_000;
    const remainingTestBudgetMs = 6 * 30_000;
    const teardownBudgetMs = 30_000;
    expect(timeoutMs).toBeGreaterThanOrEqual(
      observedElapsedMs + remainingTestBudgetMs + teardownBudgetMs,
    );
    expect(timeoutMs).toBeLessThan(job['timeout-minutes'] * 60_000);
    expect(storybook['continue-on-error']).toBeUndefined();
  });

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
      1, 2, 3, 4, 5, 6,
    ]);
    expect(workflow.jobs['android-e2e']['timeout-minutes']).toBe(
      '${{ matrix.shard == 3 && 240 || matrix.shard == 4 && 240 || 180 }}',
    );
  });

  it('runs the complete documentation gate for docs and code changes', () => {
    const job = workflow.jobs['docs-gate'];
    expect(job.if).toContain('!cancelled()');
    expect(job.if).toContain("github.event_name != 'schedule'");
    expect(job.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      'pnpm format:check',
      'node scripts/retired-playwright-predecessors.mjs fetch',
      'pnpm nx test scripts',
      'pnpm nx test docs-site',
      'pnpm nx run docs-site:check',
      'pnpm nx run docs-site:assemble',
      'pnpm nx run docs-site:e2e',
    ]);
  });

  it('fetches the retired-predecessor commit before every job that runs the guards', () => {
    const fetch = 'node scripts/retired-playwright-predecessors.mjs fetch';
    const jobs = [
      [workflow.jobs.test, 'pnpm test'],
      [workflow.jobs['docs-gate'], 'pnpm nx test scripts'],
      [
        yaml('.github/workflows/docs-pages.yml').jobs.build,
        'pnpm nx test scripts',
      ],
      [yaml('.github/workflows/release.yml').jobs.verify, 'pnpm test'],
    ];
    for (const [job, tests] of jobs) {
      const runs = job.steps.map((step) => step.run);
      expect(runs).toContain(fetch);
      expect(runs.indexOf(fetch)).toBeLessThan(runs.indexOf(tests));
    }
  });

  it('uploads only started suites, including hidden output, after ordinary failures', async () => {
    const isUpload = (step) =>
      step.uses === './.github/actions/upload-playwright-diagnostics';
    const uploads = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter(isUpload);
    const uploadIdentities = uploads.map((step) =>
      [step.with.surface, step.with.shard, step.with['report-path']].join('|'),
    );
    expect(new Set(uploadIdentities).size).toBe(uploads.length);

    // Every upload is gated on its own job's earlier step having started.
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? [];
      const surfaces = steps.filter(isUpload).map((step) => step.with.surface);
      expect(new Set(surfaces).size).toBe(surfaces.length);
      for (const [index, step] of steps.entries()) {
        if (!isUpload(step)) continue;
        const started = step.if.match(
          /^\$\{\{ !cancelled\(\) && steps\.([a-z0-9-]+)\.outputs\.([a-z0-9-]*started) == 'true'(?: && |\s\}\}$)/u,
        );
        expect(started, step.with.surface).not.toBeNull();
        const owner = steps.findIndex(
          (candidate) => candidate.id === started[1],
        );
        expect(owner).toBeGreaterThan(-1);
        expect(owner).toBeLessThan(index);
        const body = steps[owner].run ?? steps[owner].with?.script ?? '';
        expect(body).toContain(`echo '${started[2]}=true' >> "$GITHUB_OUTPUT"`);
        expect(step.with.surface).toBeTruthy();
        expect(step.with['report-path']).toContain('dist/.playwright/');
      }
    }

    // Every Android started flag has exactly one matching upload, every upload
    // belongs to an echoed flag, and a suite with a publication gate uploads only
    // behind that gate's exact safe marker.
    const steps = workflow.jobs['android-e2e'].steps;
    const script = steps.find((step) => step.id === 'android').with.script;
    const flags = [
      ...script.matchAll(/echo '([a-z0-9-]+)-started=true'/gu),
    ].map((match) => match[1]);
    expect(new Set(flags).size).toBe(flags.length);
    const androidUploads = steps.filter(isUpload);
    const flagOf = (step) =>
      step.if.match(
        /steps\.android\.outputs\.([a-z0-9-]+)-started == 'true'/u,
      )?.[1];
    expect(androidUploads.map(flagOf).filter(Boolean).sort()).toEqual(
      [...flags].sort(),
    );
    expect(
      androidUploads
        .filter((step) => flagOf(step) === undefined)
        .map((step) => step.if),
    ).toEqual([
      "${{ !cancelled() && steps.android.outputs.started == 'true' }}",
    ]);
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const suiteDirectory = (target) =>
      RUNNER_E2E_SUITES.find(
        (suite) => suite.currentTarget === `trinity-e2e-android:${target}`,
      )?.id;
    for (const line of script.split('\n')) {
      const run = line.match(
        /echo '([a-z0-9-]+)-started=true'.* trinity-e2e-android:([a-z0-9-]+); fi$/u,
      );
      if (!run) continue;
      const [, flag, target] = run;
      const matching = androidUploads.filter((step) => flagOf(step) === flag);
      expect(matching, flag).toHaveLength(1);
      const [upload] = matching;
      expect(upload.with.shard).toBe('${{ matrix.shard }}');
      expect(upload.with.surface).toBe(`android-${target}`);
      expect(suiteDirectory(target), target).toBeDefined();
      expect(upload.with['report-path']).toBe(
        `dist/.playwright/trinity-e2e-android/*/${suiteDirectory(target)}/**`,
      );
      const gate = steps.find((step) => step.id === `${target}-artifact-gate`);
      const started = `steps.android.outputs.${flag}-started == 'true'`;
      if (gate) {
        expect(gate.if).toBe(`\${{ !cancelled() && ${started} }}`);
        expect(gate.run).toContain(
          `-path '*/${suiteDirectory(target)}/${target}/publication-safe'`,
        );
        expect(gate.run).toContain(
          `echo '${target}-safe=true' >> "$GITHUB_OUTPUT"`,
        );
        expect(upload.if).toBe(
          `\${{ !cancelled() && ${started} && steps.${target}-artifact-gate.outputs.${target}-safe == 'true' }}`,
        );
        expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(gate));
      } else {
        expect(upload.if).toBe(`\${{ !cancelled() && ${started} }}`);
      }
    }
    for (const gate of steps.filter((step) =>
      step.id?.endsWith('-artifact-gate'),
    )) {
      const target = gate.id.replace(/-artifact-gate$/u, '');
      expect(script).toContain(`trinity-e2e-android:${target}; fi`);
    }
    const action = yaml(
      '.github/actions/upload-playwright-diagnostics/action.yml',
    );
    const upload = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    const identifiers = action.runs.steps.find(
      (step) => step.id === 'matrix-identifiers',
    );
    expect(action.runs.steps.indexOf(identifiers)).toBe(0);
    expect(identifiers.if).toBe(
      "${{ inputs.surface == 'android' || startsWith(inputs.surface, 'android-') }}",
    );
    expect(identifiers.run).toBe('node scripts/ci-matrix-identifiers.mjs');
    expect(identifiers.env.CI_REPORT_PATH).toBe('${{ inputs.report-path }}');
    // Every other surface, browser and Electron included, passes the
    // credential redaction, which also rewrites blob, HTML and trace archives.
    const credentials = action.runs.steps.find(
      (step) => step.id === 'matrix-credentials',
    );
    expect(action.runs.steps.indexOf(credentials)).toBe(1);
    expect(credentials.if).toBe(
      "${{ inputs.surface != 'android' && !startsWith(inputs.surface, 'android-') }}",
    );
    expect(credentials.run).toBe('node scripts/ci-matrix-credentials.mjs');
    expect(credentials.env.CI_REPORT_PATH).toBe('${{ inputs.report-path }}');
    expect(upload.if).toBe(
      "${{ !cancelled() && (steps.matrix-identifiers.outputs.verified == 'true' || steps.matrix-credentials.outputs.verified == 'true') }}",
    );
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

  it('defers a diagnostics failure to the end of the job, so later suites still run', () => {
    // Run 36325006948: the Storybook upload's redaction failed, the failed step
    // skipped every later step, and the canonical, renderer, styling and QR
    // suites never ran.
    const action = yaml(
      '.github/actions/upload-playwright-diagnostics/action.yml',
    );
    const steps = action.runs.steps;
    const verifying = ['matrix-identifiers', 'matrix-credentials', 'reports'];
    for (const id of verifying) {
      const step = steps.find((candidate) => candidate.id === id);
      expect(step?.['continue-on-error'], id).toBe(true);
    }
    // Every other step either cannot fail on verification or is the upload.
    for (const step of steps)
      if (step.run && !verifying.includes(step.id))
        expect(step.run).not.toMatch(/\bexit [1-9]|node scripts\//u);
    const deferral = steps.at(-1);
    expect(deferral.name).toBe(
      'Defer unverified diagnostics to the end of the job',
    );
    expect(deferral.if).toBe(
      "${{ !cancelled() && (steps.matrix-identifiers.outcome == 'failure' || steps.matrix-credentials.outcome == 'failure' || steps.reports.outcome == 'failure') }}",
    );
    expect(deferral.run).toContain('TRINITY_UNVERIFIED_DIAGNOSTICS=');
    expect(deferral.run).toContain('>> "$GITHUB_ENV"');

    const isUpload = (step) =>
      step.uses === './.github/actions/upload-playwright-diagnostics';
    const jobs = Object.entries(workflow.jobs).filter(([, job]) =>
      (job.steps ?? []).some(isUpload),
    );
    expect(jobs.map(([name]) => name).sort()).toEqual([
      'android-e2e',
      'desktop',
      'e2e',
      'scheduled-e2e',
    ]);
    for (const [name, job] of jobs) {
      const final = job.steps.at(-1);
      expect(final.name, name).toBe('Fail on unverified diagnostics');
      // The shell reads the deferred list: GITHUB_ENV reaches later steps'
      // environments, so the check does not depend on expression evaluation.
      expect(final.if, name).toBe('${{ !cancelled() }}');
      expect(final.run, name).toContain(
        'if [ -n "${TRINITY_UNVERIFIED_DIAGNOSTICS:-}" ]; then',
      );
      expect(final.run, name).toContain('exit 1');
    }
  });

  it('runs every native Android suite once, on its own shard, before retained Playwright', () => {
    const job = workflow.jobs['android-e2e'];
    const lines = job.steps
      .find((step) => step.id === 'android')
      .with.script.split('\n')
      .map((line) => line.trim());
    const retained = lines.findIndex((line) =>
      line.includes('pnpm e2e:android --'),
    );
    const targets = lines.flatMap(
      (line) => line.match(/ trinity-e2e-android:([a-z0-9-]+)/u)?.[1] ?? [],
    );
    expect(targets[0]).toBe('runner-smoke');
    expect(targets.sort()).toEqual(
      ANDROID_NATIVE_PLACEMENT.map(([target]) => target).sort(),
    );
    for (const [target, shard, flag, timeoutMs] of ANDROID_NATIVE_PLACEMENT) {
      const matching = lines.filter((line) =>
        line.endsWith(` trinity-e2e-android:${target}; fi`),
      );
      expect(matching, target).toHaveLength(1);
      const [line] = matching;
      expect(job.strategy.matrix.shard).toContain(shard);
      expect(line).toMatch(
        new RegExp(
          `^if \\[ "\\$\\{\\{ matrix\\.shard \\}\\}" = "${shard}" \\]; then echo '${flag}-started=true' >> "\\$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="\\$ANDROID_SERIAL" node scripts/ci-run-command\\.mjs --timeout-ms ${timeoutMs} -- pnpm (?:exec )?nx run trinity-e2e-android:${target}; fi$`,
          'u',
        ),
      );
      expect(lines.indexOf(line)).toBeLessThan(retained);
    }
  });

  it('keeps every Android shard budget figure inside its job timeout', () => {
    const job = workflow.jobs['android-e2e'];
    const comment = readFileSync(
      resolve(root, '.github/workflows/ci.yml'),
      'utf8',
    )
      .split('\n  android-e2e:\n')[1]
      .split('    timeout-minutes:')[0]
      .split('\n')
      .map((line) => line.trim().replace(/^# ?/, ''))
      .join(' ');
    const retained = job.steps
      .find((step) => step.id === 'android')
      .with.script.split('\n')
      .find((line) => line.includes('pnpm e2e:android --'));
    const retainedMinutes =
      Number(retained.match(/--timeout-ms (\d+)/u)?.[1]) / 60_000;
    const diagnosticsMinutes = 15;
    const expression = job['timeout-minutes'];
    const timeoutFor = (shard) =>
      Number(
        expression.match(
          new RegExp(`matrix\\.shard == ${shard} && (\\d+)`, 'u'),
        )?.[1] ?? expression.match(/\|\| (\d+) \}\}$/u)?.[1],
      );
    for (const shard of job.strategy.matrix.shard) {
      const figure = Number(
        comment.match(new RegExp(`shard ${shard} about (\\d+)`, 'u'))?.[1],
      );
      expect(figure, `shard ${shard}`).toBeGreaterThan(0);
      expect(figure + retainedMinutes + diagnosticsMinutes).toBeLessThanOrEqual(
        timeoutFor(shard),
      );
    }
    // The figures come from measured hosted runs, not provisional additions.
    expect(comment).toMatch(/\bruns \d{11} and \d{11}\b/u);
    expect(comment).not.toMatch(/provisional/u);
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
    expect(chrome.if).toBe('${{ matrix.shard == 5 }}');
    // Both SSO suites drive the pinned Chrome fixture, so they share its shard.
    for (const target of ['legacy-sso', 'sso-recovery-reset'])
      expect(
        ANDROID_NATIVE_PLACEMENT.find(([name]) => name === target)?.[1],
        target,
      ).toBe(5);
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

    for (const line of lines) {
      expect(() => execFileSync('sh', ['-n', '-c', line])).not.toThrow();
    }
  });
});
