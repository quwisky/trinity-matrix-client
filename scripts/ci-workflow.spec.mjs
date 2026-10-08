/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
      return {
        setup: setup.with?.browsers,
        withDeps: setup.with?.['with-deps'],
        env: prerequisites?.env,
      };
    };
    // The ubuntu image ships Chrome's libraries, so only the Chromium shards skip --with-deps.
    expect(install('browser-e2e')).toEqual({
      setup: 'chromium',
      withDeps: 'false',
      env: {
        TRINITY_PLAYWRIGHT_BROWSERS: 'chromium',
        TRINITY_PLAYWRIGHT_WITH_DEPS: 'false',
      },
    });
    expect(install('e2e')).toEqual({
      setup: undefined,
      withDeps: undefined,
      env: undefined,
    });
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

describe('Android E2E split', () => {
  const job = workflow.jobs['mobile-e2e'];
  const steps = job.steps;
  const specsOf = ({ specs }) => specs.split(',').map((spec) => spec.trim());

  it('splits every Android spec file across two disjoint shards', () => {
    const include = job.strategy.matrix.include;
    expect(job.strategy['fail-fast']).toBe(false);
    expect(include.map(({ shard }) => shard)).toEqual([1, 2]);
    const selected = include.flatMap(specsOf);
    const files = readdirSync(resolve(root, 'e2e/mobile/specs'))
      .filter((file) => file.endsWith('.e2e.mts'))
      .map((file) => `./specs/${file}`);
    expect([...selected].sort()).toEqual(files.sort());
    expect(new Set(selected).size).toBe(selected.length);
    for (const entry of include)
      expect(specsOf(entry).length).toBeGreaterThan(0);
  });

  it('selects the shard specs and names the artifact by shard', () => {
    const emulator = steps.find((step) => step.id === 'mobile');
    expect(emulator.env.TRINITY_MOBILE_SPECS).toBe('${{ matrix.specs }}');
    expect(job.name).toContain('${{ matrix.shard }}');
    expect(diagnosticsUpload(job).with.shard).toBe('${{ matrix.shard }}');
  });

  it('builds the app while the emulator boots and starts the suite only after the build', () => {
    const build = steps.find((step) => step.id === 'android-prebuild');
    const pull = steps.find((step) => step.id === 'homeserver-pull');
    const emulator = steps.find((step) => step.id === 'mobile');
    expect(build.background).toBe(true);
    expect(build['timeout-minutes']).toBeGreaterThan(0);
    expect(build.run).toContain('pnpm android:build:prebuilt');
    expect(build.run).toContain('assembleSecondaryDebug');
    expect(build.run).toContain('> dist/.ci/android-prebuild.status');
    expect(pull.background).toBe(true);
    expect(pull['continue-on-error']).toBe(true);
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(emulator));
    expect(steps.indexOf(pull)).toBeLessThan(steps.indexOf(emulator));
    const lines = emulator.with.script.trim().split('\n');
    expect(lines[0]).toMatch(/^timeout \d+ sh -c '/);
    expect(lines[0]).toContain('dist/.ci/android-prebuild.status');
    expect(lines[1]).toBe(`echo 'started=true' >> "$GITHUB_OUTPUT"`);
    const wait = steps[steps.indexOf(emulator) + 1];
    expect(wait.wait).toEqual(['android-prebuild', 'homeserver-pull']);
  });

  it('reports both Android jobs under the required check name', () => {
    const gate = workflow.jobs['mobile-e2e-result'];
    expect(gate.name).toBe('Mobile E2E (Android)');
    expect(gate.needs).toEqual(['classify', 'mobile-e2e']);
    expect(gate.steps).toEqual([RESULT_GATE_STEP]);
    expect(job.name).not.toBe('Mobile E2E (Android)');
  });
});

describe('Unit test selection', () => {
  it('re-runs every Vitest project when the shared Vitest setup changes', () => {
    const nx = JSON.parse(readFileSync(resolve(root, 'nx.json'), 'utf8'));
    expect(nx.targetDefaults.test.inputs).toEqual([
      'default',
      '^production',
      '{workspaceRoot}/vite.base.config.ts',
      '{workspaceRoot}/test-setup.base.ts',
    ]);
  });

  it('tests the projects whose specs read files outside their own graph', () => {
    // These specs grep or read other projects' files with no import edge, so only their
    // declared test inputs make `nx affected` pick them up.
    const affected = (file) =>
      JSON.parse(
        execFileSync(
          'pnpm',
          [
            'exec',
            'nx',
            'show',
            'projects',
            '--affected',
            `--files=${file}`,
            '--json',
          ],
          { cwd: root, encoding: 'utf8' },
        ),
      );
    for (const file of [
      'libs/feature/rooms/src/lib/rooms/rooms.page.html',
      'libs/feature/rooms/src/lib/rooms/rooms.component.ts',
    ]) {
      expect(affected(file), file).toEqual(
        expect.arrayContaining([
          'components-foundations',
          'application-runtime',
        ]),
      );
    }
    expect(affected('apps/trinity/src/global.scss')).toContain(
      'application-runtime',
    );
  });

  const runs = (id) =>
    workflow.jobs[id].steps.flatMap((step) => (step.run ? [step.run] : []));
  const unit = () =>
    workflow.jobs.test.steps.find((step) => step.id === 'unit');

  it('type-checks every project in Lint & format, not in Unit tests', () => {
    expect(workflow.jobs.quality.name).toBe('Lint & format');
    expect(runs('quality')).toContain('pnpm exec nx run-many -t typecheck');
    expect(runs('test').join('\n')).not.toContain('typecheck');
  });

  it('tests affected projects against the pull request base and everything otherwise', () => {
    expect(workflow.jobs.test.name).toBe('Unit tests');
    expect(workflow.jobs.test.steps[0].with['fetch-depth']).toBe(0);
    const step = unit();
    expect(step.env.BASE).toBe('${{ github.event.pull_request.base.sha }}');
    expect(step.run).toContain(
      'if [ "$GITHUB_EVENT_NAME" != pull_request ]; then\n  pnpm test\n',
    );
    expect(step.run).toContain(
      'pnpm nx affected -t test --base="$BASE" --head=HEAD',
    );
  });

  it('lists changed paths unquoted and without rename detection', () => {
    // A root file moved into a subdirectory must still list its old root path, and
    // non-ASCII paths must not come back quoted, or the root-level guard misses them.
    expect(unit().run).toContain(
      'git -c core.quotePath=false diff --no-renames --name-only "$BASE...HEAD"',
    );
  });

  it('tests every project when a root-level or workflow file changes', () => {
    const pattern = new RegExp(
      unit().run.match(/grep -E '([^']+)' > \/dev\/null/)[1],
    );
    for (const path of [
      'vite.base.config.ts',
      'test-setup.base.ts',
      '.nvmrc',
      'package.json',
      'pnpm-lock.yaml',
      '.github/actions/setup/action.yml',
      '.github/workflows/ci.yml',
    ]) {
      expect(pattern.test(path), path).toBe(true);
    }
    for (const path of [
      'libs/feature/rooms/src/index.ts',
      'apps/trinity/vite.config.ts',
      'scripts/ci-classify.mjs',
      'e2e/browser/playwright.config.mts',
    ]) {
      expect(pattern.test(path), path).toBe(false);
    }
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
