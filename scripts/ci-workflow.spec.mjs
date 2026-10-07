/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { CODE_JOB_IDS } from './ci-classify.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const workflow = yaml('.github/workflows/ci.yml');

/** The single step of every result job that reports split jobs under one required check. */
const RESULT_GATE_STEP = {
  name: 'Require every split job to succeed',
  env: { NEEDS: '${{ toJSON(needs) }}' },
  run: `echo "$NEEDS" | jq -r 'to_entries[] | "\\(.key) \\(.value.result)"'\necho "$NEEDS" | jq -e 'all(.[]; .result == "success")' > /dev/null\n`,
};
const diagnosticsUpload = (job) =>
  job.steps.find(
    (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
  );

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
    expect(workflow.jobs['android-e2e']).toBeUndefined();
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
      `echo 'started=true' >> "$GITHUB_OUTPUT"\npnpm nx run docs-site:e2e\n`,
    ]);
  });

  it('keeps docs-site Playwright traces when its suite ran', () => {
    // The docs suite is not a registry suite, so it uploads directly rather than through
    // the registry-validated diagnostics action, with the same artifact conventions.
    const steps = workflow.jobs['docs-gate'].steps;
    const run = steps.findIndex((step) => step.id === 'docs-e2e');
    const upload = steps[run + 1];
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.if).toBe(
      "${{ !cancelled() && steps.docs-e2e.outputs.started == 'true' }}",
    );
    expect(upload.with.path).toBe('dist/.playwright/docs-site/\n');
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with.name).toContain('docs-site');
  });

  it('uploads only started suites, including hidden output, after ordinary failures', () => {
    const uploads = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter(
        (step) =>
          step.uses === './.github/actions/upload-playwright-diagnostics',
      );
    expect(uploads.length).toBe(8);
    for (const step of uploads) {
      expect(step.if).toMatch(/!cancelled\(\).*outputs.started == 'true'/);
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

  it('uploads mobile diagnostics only after the identifier scrub succeeded', () => {
    const steps = workflow.jobs['mobile-e2e'].steps;
    const scrub = steps.find((step) => step.id === 'mobile-scrub');
    expect(scrub.if).toContain('!cancelled()');
    const upload = steps.find(
      (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
    );
    expect(upload.if).toContain("steps.mobile-scrub.outcome == 'success'");
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(scrub));
  });

  it('waits for KVM udev completion and separates Appium and Gradle caches', () => {
    const steps = workflow.jobs['mobile-e2e'].steps;
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
          !step.with.path.includes('.appium'),
      ),
    ).toBe(true);
    expect(
      caches.some(
        (step) =>
          step.with.path.includes('.appium') &&
          !step.with.path.includes('.gradle'),
      ),
    ).toBe(true);
  });
});

describe('split E2E jobs', () => {
  const jobs = workflow.jobs;

  it('shards the browser journeys across three jobs that do not wait for the renderer', () => {
    const job = jobs['browser-e2e'];
    expect([job.needs].flat()).toEqual(['classify']);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.shard).toEqual([1, 2, 3]);
    expect(job.name).toContain('${{ matrix.shard }}');
    const browser = job.steps.find((step) => step.id === 'browser');
    expect(browser.env.TRINITY_E2E_SHARD).toBe('${{ matrix.shard }}/3');
    expect(browser.run).toContain('pnpm exec nx run trinity-e2e-browser:e2e');
    expect(diagnosticsUpload(job).with.shard).toBe('${{ matrix.shard }}');
    expect(job.steps.some((step) => step.id === 'prerequisites')).toBe(true);
  });

  it('runs the Storybook check without the renderer or the homeserver prerequisites', () => {
    const job = jobs.storybook;
    expect([job.needs].flat()).toEqual(['classify']);
    expect(job.steps.some((step) => step.id === 'prerequisites')).toBe(false);
    expect(job.steps.find((step) => step.id === 'storybook').run).toContain(
      'pnpm exec nx run trinity-e2e-components:storybook',
    );
  });

  it('keeps only the renderer-backed checks in the e2e job', () => {
    expect(jobs.e2e.steps.map((step) => step.id).filter(Boolean)).toEqual([
      'prerequisites',
      'renderer',
      'styling',
      'qr',
    ]);
  });

  it('reports the split E2E jobs under the required check name', () => {
    const gate = jobs['e2e-result'];
    expect(gate.name).toBe('E2E (Playwright + homeserver)');
    expect(gate.needs).toEqual(['classify', 'e2e', 'browser-e2e', 'storybook']);
    expect(gate.steps).toEqual([RESULT_GATE_STEP]);
    for (const id of ['e2e', 'browser-e2e', 'storybook']) {
      expect(jobs[id].name).not.toBe('E2E (Playwright + homeserver)');
    }
  });

  it('installs only Chromium for the browser shards and keeps WebKit elsewhere', () => {
    const install = (id) => {
      const steps = jobs[id].steps;
      const setup = steps.find(
        (step) => step.uses === './.github/actions/setup-playwright',
      );
      const prerequisites = steps.find((step) => step.id === 'prerequisites');
      return { setup: setup.with?.browsers, env: prerequisites?.env };
    };
    expect(install('browser-e2e')).toEqual({
      setup: 'chromium',
      env: { TRINITY_PLAYWRIGHT_BROWSERS: 'chromium' },
    });
    expect(install('e2e')).toEqual({ setup: undefined, env: undefined });
    expect(
      jobs.storybook.steps.find(
        (step) => step.uses === './.github/actions/setup-playwright',
      ).with,
    ).toBeUndefined();
  });

  it('names each prerequisites artifact by job, and by shard in the matrix', () => {
    const name = (id) =>
      jobs[id].steps.find((step) => step.with?.path === 'dist/.ci/').with.name;
    expect(name('e2e')).toContain('${{ github.job }}');
    expect(name('browser-e2e')).toContain(
      '${{ github.job }}-${{ matrix.shard }}',
    );
  });
});

describe('iOS nightly E2E workflow', () => {
  const ios = yaml('.github/workflows/e2e-ios-nightly.yml');
  const steps = ios.jobs.ios.steps;

  it('runs the iOS suite on macOS against native Synapse', () => {
    expect(ios.on).toHaveProperty('workflow_dispatch');
    expect(ios.env).toMatchObject({
      TRINITY_E2E_HOMESERVER: 'synapse',
      TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
    });
    expect(ios.jobs.ios['runs-on']).toBe('macos-26');
    expect(ios.jobs.ios['timeout-minutes']).toBe(90);
    const mobile = steps.find((step) => step.id === 'mobile');
    expect(mobile.run).toContain('pnpm e2e:mobile:ios');
    expect(mobile.env.TRINITY_E2E_PREBUILT_WWW).toBe('1');
  });

  it('uploads iOS diagnostics only after the identifier scrub succeeded', () => {
    const scrub = steps.find((step) => step.id === 'mobile-scrub');
    expect(scrub.if).toContain('!cancelled()');
    const upload = steps.find(
      (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
    );
    expect(upload.if).toContain("steps.mobile-scrub.outcome == 'success'");
    expect(upload.with['report-path']).toBe(
      'dist/.playwright/trinity-e2e-mobile/*/mobile.ios/**',
    );
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(scrub));
  });
});
