/** The CI graph must fail closed and preserve diagnostics independently of suite success. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { CODE_JOB_IDS } from './ci-classify.mjs';
import { workflow as loadWorkflow, workflows } from './workspace-sources.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const workflow = loadWorkflow('ci.yml');

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
    expect(uploads.length).toBeGreaterThan(0);
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
      step.uses?.startsWith('actions/cache/restore@'),
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
    expect(gate.needs).toEqual([
      'classify',
      'e2e',
      'browser-e2e',
      'storybook',
      'mas-e2e',
      'tuwunel-oauth-e2e',
      'scrollbars-e2e',
    ]);
    for (const id of [
      'e2e',
      'browser-e2e',
      'storybook',
      'mas-e2e',
      'tuwunel-oauth-e2e',
      'scrollbars-e2e',
    ]) {
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

describe('QR sign-in journeys on Tuwunel OAuth', () => {
  const jobs = workflow.jobs;
  const job = jobs['tuwunel-oauth-e2e'];
  const browser = job.steps.find((candidate) => candidate.id === 'browser');

  it('runs on the same pull requests as the MAS journeys', () => {
    expect([job.needs].flat()).toEqual(['classify']);
    expect(job.if).toBe(jobs['mas-e2e'].if);
  });

  it('starts Tuwunel OAuth for every step and runs only the QR journeys', () => {
    // At job level, so the prerequisites step pulls this kind's images too.
    expect(job.env).toEqual({ TRINITY_E2E_HOMESERVER: 'tuwunel-oauth' });
    expect(browser.env).toEqual({
      TRINITY_E2E_SPEC: 'accounts/qr-sign-in.spec.mts',
    });
    expect(browser.run).toContain(
      '-- pnpm exec nx run trinity-e2e-browser:e2e\n',
    );
    expect(browser.run).toContain('--timeout-ms 1200000 --');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(
      job.steps.some((candidate) => candidate.id === 'prerequisites'),
    ).toBe(true);
  });

  it('keeps its diagnostics apart from the other browser jobs', () => {
    expect(diagnosticsUpload(job).with.surface).toBe('browser-tuwunel-oauth');
    expect(
      job.steps.find((candidate) => candidate.with?.path === 'dist/.ci/').with
        .name,
    ).toContain('${{ github.job }}');
  });
});

describe('MAS sign-in journeys', () => {
  const jobs = workflow.jobs;
  const job = jobs['mas-e2e'];
  const gate = jobs['e2e-result'];
  const step = (id) => job.steps.find((candidate) => candidate.id === id);

  it('runs only when the classifier found sign-in changes in a pull request', () => {
    expect([job.needs].flat()).toEqual(['classify']);
    expect(jobs.classify.outputs.mas).toBe('${{ steps.mas.outputs.run }}');
    expect(job.if).toContain('!cancelled()');
    expect(job.if).toContain("github.event_name != 'schedule'");
    expect(job.if).toContain("needs.classify.outputs.mas == 'true'");
  });

  it('starts the MAS stack and runs only the MAS journeys, under the registered browser command', () => {
    const browser = step('browser');
    expect(browser.env.TRINITY_E2E_MAS).toBe('1');
    // The E2E registry pins this command line, so the spec is selected by environment,
    // as the shard is, and not by an argument.
    expect(browser.env.TRINITY_E2E_SPEC).toBe('accounts/mas-session.spec.mts');
    expect(browser.run).toContain(
      '-- pnpm exec nx run trinity-e2e-browser:e2e\n',
    );
    // The command budget covers setup of the stack and the build, not only the specs.
    expect(browser.run).toContain('--timeout-ms 1200000 --');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(
      job.steps.some((candidate) => candidate.id === 'prerequisites'),
    ).toBe(true);
  });

  it('runs QR sign-in as a second invocation, with its own diagnostics', () => {
    const qr = step('qr');
    expect(qr.env).toEqual({
      TRINITY_E2E_MAS: '1',
      TRINITY_E2E_SPEC: 'accounts/qr-sign-in.spec.mts',
    });
    expect(qr.run).toContain('-- pnpm exec nx run trinity-e2e-browser:e2e\n');
    expect(qr.run).toContain('--timeout-ms 1200000 --');
    // A failed MAS session journey must not hide the QR results.
    expect(qr.if).toContain("steps.prerequisites.outcome == 'success'");
    const uploads = job.steps.filter(
      (candidate) =>
        candidate.uses === './.github/actions/upload-playwright-diagnostics',
    );
    expect(uploads.map((upload) => upload.with.surface)).toEqual([
      'browser-mas',
      'browser-mas-qr',
    ]);
    expect(uploads[1].if).toContain("steps.qr.outputs.started == 'true'");
  });

  it('is the only job that opts into the MAS stack', () => {
    for (const [id, other] of Object.entries(jobs)) {
      if (id === 'mas-e2e') continue;
      expect(JSON.stringify(other), id).not.toContain('TRINITY_E2E_MAS');
    }
  });

  it('keeps its diagnostics and prerequisites artifacts apart from the shards', () => {
    expect(diagnosticsUpload(job).with.surface).toBe('browser-mas');
    expect(diagnosticsUpload(job).with['report-path']).toBe(
      'dist/.playwright/trinity-e2e-browser/*/browser.canonical/**',
    );
    expect(
      job.steps.find((candidate) => candidate.with?.path === 'dist/.ci/').with
        .name,
    ).toContain('${{ github.job }}');
  });

  describe('required check', () => {
    const run = (overrides) => {
      expect(gate.needs).toContain('mas-e2e');
      const needs = Object.fromEntries(
        gate.needs.map((id) => [id, { result: overrides[id] ?? 'success' }]),
      );
      return spawnSync('bash', ['-e', '-c', gate.steps[0].run], {
        env: { ...process.env, NEEDS: JSON.stringify(needs) },
        encoding: 'utf8',
      });
    };

    it('passes when every job succeeded', () => {
      expect(run({}).status).toBe(0);
    });

    // Each is skipped by design when a pull request leaves the paths it checks alone.
    const pathFiltered = ['mas-e2e', 'tuwunel-oauth-e2e', 'scrollbars-e2e'];

    it.each(pathFiltered)('passes when only %s was skipped', (id) => {
      expect(run({ [id]: 'skipped' }).status).toBe(0);
    });

    it.each(
      pathFiltered.flatMap((id) => [
        [id, 'failure'],
        [id, 'cancelled'],
      ]),
    )('fails when %s ends in %s', (id, result) => {
      expect(run({ [id]: result }).status).not.toBe(0);
    });

    it('fails when any job that always runs did not succeed', () => {
      for (const id of gate.needs.filter(
        (need) => !pathFiltered.includes(need),
      )) {
        for (const result of ['skipped', 'failure', 'cancelled']) {
          expect(run({ [id]: result }).status, `${id} ${result}`).not.toBe(0);
        }
      }
    });

    it('still lists each job result in its log', () => {
      expect(run({ 'mas-e2e': 'skipped' }).stdout).toContain('mas-e2e skipped');
    });
  });

  describe('change detection', () => {
    const script = () =>
      jobs.classify.steps.find((candidate) => candidate.id === 'mas').run;
    const files = {
      'package.json':
        '{\n  "dependencies": {\n    "@matrix-org/matrix-sdk-crypto-wasm": "^18.4.0",\n    "matrix-js-sdk": "^43.0.0",\n    "rxjs": "^7.8.0"\n  }\n}\n',
      'pnpm-lock.yaml':
        "importers:\n  .:\n    dependencies:\n      matrix-js-sdk:\n        specifier: ^43.0.0\n        version: 43.0.0\n      rxjs:\n        specifier: ^7.8.0\n        version: 7.8.0\npackages:\n  '@matrix-org/matrix-sdk-crypto-wasm@18.9.0':\n    resolution: {integrity: sha512-w}\n  matrix-js-sdk@43.0.0:\n    resolution: {integrity: sha512-m}\n  rxjs@7.8.0:\n    resolution: {integrity: sha512-a}\n",
      'pnpm-workspace.yaml':
        'patchedDependencies:\n  matrix-js-sdk@43.0.0: patches/matrix-js-sdk@43.0.0.patch\n  pagefind@1.5.2: patches/pagefind@1.5.2.patch\n',
      'libs/data-access/media/src/index.ts': 'export {};\n',
    };
    const git = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    let repo;
    let base;
    const sh = (...args) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...git,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
      });
    const write = (changes) => {
      for (const [path, content] of Object.entries(changes)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
    };
    /** Runs the classifier's `mas` step in the repo; `output` is what it wrote to GITHUB_OUTPUT. */
    const runStep = (event, baseSha) => {
      const output = join(repo, '.output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', script()], {
        cwd: repo,
        env: {
          ...process.env,
          ...git,
          BASE: baseSha,
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
      });
      return { result, output: readFileSync(output, 'utf8').trim() };
    };
    /** The `run` output of the classifier's `mas` step for a change on top of the base. */
    const detect = (changes, event = 'pull_request') => {
      write(changes);
      sh('add', '-A');
      sh('commit', '-m', 'change');
      const { result, output } = runStep(
        event,
        event === 'pull_request' ? base : '',
      );
      expect(result.status, result.stderr).toBe(0);
      return output;
    };
    const replaceIn = (path, from, to) => ({
      [path]: files[path].replace(from, to),
    });

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'trinity-mas-detect-'));
      sh('init', '-q', '-b', 'main');
      write(files);
      sh('add', '-A');
      sh('commit', '-q', '-m', 'base');
      base = sh('rev-parse', 'HEAD').trim();
    });
    afterEach(() => {
      sh('reset', '-q', '--hard', base);
      sh('clean', '-q', '-fd');
    });
    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it.each([
      'libs/data-access/auth/src/lib/auth.service.ts',
      'libs/data-access/matrix-client/src/lib/matrix-client.service.ts',
      'libs/data-access/accounts/src/lib/account-session.ts',
      'libs/feature/auth/src/lib/sso-callback/sso-callback.page.ts',
      'libs/platform-native/src/lib/session-storage.service.ts',
      'libs/platform-native/src/lib/secure-storage.service.ts',
      'libs/util/matrix/src/lib/session.model.ts',
      'libs/application/runtime/src/lib/composition/application-capability.providers.ts',
      'patches/matrix-js-sdk@43.0.1.patch',
      'e2e/support/homeserver/mas/mas.yaml',
      'e2e/browser/journeys/accounts/mas-session.spec.mts',
      'e2e/browser/support/mas.mts',
      'e2e/support/homeserver/Caddyfile',
      'e2e/support/homeserver/start.mjs',
      'e2e/support/homeserver/stop.mjs',
      'e2e/support/homeserver/constants.mjs',
      'e2e/support/homeserver/kind.mts',
      'e2e/support/homeserver/paths.mjs',
      'e2e/browser/journeys/accounts/qr-sign-in.spec.mts',
      'e2e/browser/support/qr-existing-device.mts',
      'e2e/support/qr-camera.mts',
      'e2e/support/homeserver/tuwunel-oauth/tuwunel.toml',
      'libs/data-access/auth/src/lib/qr-sign-in/qr-sign-in.adapter.ts',
      'libs/feature/settings/src/lib/devices/link-device/link-device.component.ts',
      'libs/data-access/trust/src/lib/trust-devices.service.ts',
      'libs/feature/settings/src/lib/devices/devices-section.component.html',
    ])('runs the journeys when a pull request changes %s', (path) => {
      expect(detect({ [path]: 'changed\n' })).toBe('run=true');
    });

    it.each([
      'libs/data-access/media/src/index.ts',
      'libs/data-access/accounts-archive/src/index.ts',
      'libs/feature/rooms/src/index.ts',
      'libs/feature/settings/src/lib/devices/device-row.component.ts',
      'patches/pagefind@1.5.3.patch',
      'e2e/support/homeserver/synapse/adapter.mjs',
      'e2e/support/homeserver/lease.mts',
      'e2e/support/homeserver/start.mjs.bak',
      'libs/platform-native/src/lib/file-save.service.ts',
      'libs/util/matrix/src/lib/message-view.ts',
      'libs/util/matrix/src/lib/message-html.ts',
      'libs/util/matrix/src/lib/markdown-render.ts',
      'e2e/support/homeserver/Caddyfile.mas',
      'e2e/browser/journeys/accounts/oidc-login.spec.mts',
      'apps/trinity/src/main.ts',
    ])('skips the journeys when a pull request changes only %s', (path) => {
      expect(detect({ [path]: 'changed\n' })).toBe('run=false');
    });

    it.each([
      ['package.json', '"^43.0.0"', '"^43.1.0"'],
      ['pnpm-lock.yaml', 'matrix-js-sdk@43.0.0:', 'matrix-js-sdk@43.1.0:'],
      ['pnpm-workspace.yaml', 'matrix-js-sdk@43.0.0', 'matrix-js-sdk@43.1.0'],
      ['package.json', '"^18.4.0"', '"^18.5.0"'],
      [
        'pnpm-lock.yaml',
        'matrix-sdk-crypto-wasm@18.9.0',
        'matrix-sdk-crypto-wasm@18.9.1',
      ],
    ])(
      'runs the journeys when %s changes the matrix-js-sdk or crypto-wasm line (%s)',
      (path, from, to) => {
        expect(detect(replaceIn(path, from, to))).toBe('run=true');
      },
    );

    it.each([
      ['package.json', '"^7.8.0"', '"^7.9.0"'],
      ['pnpm-lock.yaml', 'version: 7.8.0', 'version: 7.9.0'],
      ['pnpm-workspace.yaml', 'pagefind@1.5.2', 'pagefind@1.5.3'],
    ])(
      'skips the journeys when %s changes another dependency',
      (path, from, to) => {
        expect(detect(replaceIn(path, from, to))).toBe('run=false');
      },
    );

    it('fails, rather than answering false, when a pull request has no base', () => {
      const { result, output } = runStep('pull_request', '');
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toContain('pull request has no base sha');
      expect(output).toBe('');
    });

    it('leaves pushes to the nightly run', () => {
      expect(
        detect({ 'libs/data-access/auth/src/index.ts': 'changed\n' }, 'push'),
      ).toBe('run=false');
    });
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
    const waitLine = lines.findIndex((line) =>
      /^timeout \d+ sh -c '/.test(line),
    );
    expect(waitLine).toBeGreaterThanOrEqual(0);
    expect(lines[waitLine]).toContain('dist/.ci/android-prebuild.status');
    expect(lines[waitLine + 1]).toBe(`echo 'started=true' >> "$GITHUB_OUTPUT"`);
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
  const ios = loadWorkflow('e2e-ios-nightly.yml');
  const steps = ios.jobs.ios.steps;

  it('runs the iOS suite on macOS against native Synapse', () => {
    expect(ios.on).toHaveProperty('workflow_dispatch');
    expect(ios.env).toMatchObject({
      TRINITY_E2E_HOMESERVER: 'synapse',
      TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
    });
    expect(ios.jobs.ios['runs-on']).toBe('macos-26');
    expect(ios.jobs.ios['timeout-minutes']).toBe(100);
    const mobile = steps.find((step) => step.id === 'mobile');
    expect(mobile.run).toContain('pnpm e2e:mobile:ios');
    // Above the suite's own 80-minute limit, so that fires first and names the suite.
    expect(mobile.run).toContain('--timeout-ms 5100000 --');
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

  it('runs nightly and on demand, with no push trigger left from the draft', () => {
    expect(ios.on.schedule).toEqual([{ cron: '13 4 * * *' }]);
    expect(ios.on).toHaveProperty('workflow_dispatch');
    expect(ios.on).not.toHaveProperty('push');
    expect(
      steps.find((step) => step.id === 'mobile').env.TRINITY_MOBILE_SPECS,
    ).toBe('${{ inputs.specs }}');
  });

  it('installs Dex before the suite, so the native homeserver offers SSO', () => {
    const dex = steps.find((step) => step.name === 'Install Dex');
    expect(dex.run).toContain('brew install dexidp');
    expect(dex.run).toContain('dex version');
    expect(dex.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1');
    expect(steps.indexOf(dex)).toBeLessThan(
      steps.findIndex((step) => step.id === 'mobile'),
    );
  });

  it('caches WebDriverAgent per Xcode and driver pin, apart from pip, Appium and Caddy', () => {
    const caches = steps.filter((step) =>
      step.uses?.startsWith('actions/cache@'),
    );
    const byPath = (fragment) =>
      caches.filter((step) => step.with.path.includes(fragment));
    const [wda] = byPath('dist/ios-wda');
    expect(wda.with.key).toContain('steps.toolchain.outputs.xcode');
    expect(wda.with.key).toContain("hashFiles('scripts/setup-appium.mjs')");
    expect(byPath('Library/Caches/pip')[0].with.key).toContain(
      "hashFiles('e2e/support/homeserver/native.mts')",
    );
    expect(byPath('.appium')).toHaveLength(1);
    expect(byPath('trinity-caddy')[0].with.key).toContain('env.CADDY_VERSION');
    expect(caches).toHaveLength(4);
  });
});

describe('TestFlight upload workflow', () => {
  const FILE = 'testflight.yml';
  const SECRETS = [
    'GOOGLE_SERVICE_INFO_PLIST',
    'ASC_KEY_ID',
    'ASC_ISSUER_ID',
    'ASC_KEY_P8',
    'APPLE_TEAM_ID',
  ];
  const testflight = () => loadWorkflow(FILE);
  const build = () => testflight().jobs.renderer;
  const upload = () => testflight().jobs.testflight;
  const step = (job, key, value = key) =>
    job.steps.find((candidate) =>
      key === 'name' ? candidate.name === value : candidate.id === value,
    );
  const bash = (script, options) =>
    spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
      { encoding: 'utf8', ...options },
    );
  const inTempDir = (action) => {
    const dir = mkdtempSync(join(tmpdir(), 'testflight-'));
    try {
      return action(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('runs only when dispatched by hand', () => {
    const { on } = testflight();
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    expect(on.workflow_dispatch.inputs.tag).toMatchObject({
      required: true,
      type: 'string',
    });
  });

  it('builds the tagged commit the first job verified, in both jobs', () => {
    const checkout = (job) =>
      job.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with;
    expect(checkout(build()).ref).toBe(
      'refs/tags/${{ steps.tag.outputs.tag }}',
    );
    expect(checkout(upload()).ref).toBe('${{ needs.renderer.outputs.sha }}');
    expect(build().outputs.sha).toBe('${{ steps.commit.outputs.sha }}');
    expect(upload().needs).toContain('renderer');
  });

  it('builds without an environment or secret, then signs in release-mobile', () => {
    const { jobs, permissions, concurrency } = testflight();
    expect(Object.keys(jobs)).toEqual(['renderer', 'testflight']);
    expect(build().environment).toBeUndefined();
    expect(JSON.stringify(build())).not.toContain('secrets.');
    expect(upload().environment).toBe('release-mobile');
    expect(upload().needs).toEqual(['renderer']);
    expect(upload()['runs-on']).toBe('macos-26');
    expect(permissions).toEqual({ contents: 'read' });
    expect(concurrency['cancel-in-progress']).toBe(false);
    for (const job of Object.values(jobs)) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      const checkout = job.steps.find((s) =>
        s.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout.with['persist-credentials']).toBe(false);
      for (const { uses } of job.steps.filter((s) => s.uses)) {
        expect(uses).toMatch(/^(\.\/|[\w./-]+@[0-9a-f]{40}$)/);
      }
    }
  });

  it('bundles the release notes in the production renderer build', () => {
    const renderer = build().steps.find((s) =>
      s.run?.includes('nx build trinity'),
    );
    expect(renderer.run).toContain('--configuration=production');
    expect(renderer.env.TRINITY_RELEASE_NOTES).toBe('required');
    expect(renderer.env.GITHUB_TOKEN).toBe('${{ github.token }}');
  });

  it('runs no Nx next to the key, and writes the key only after the sync and the checks', () => {
    const steps = upload().steps;
    const runs = steps.map((s) => s.run ?? '');
    const at = (text) => runs.findIndex((r) => r.includes(text));
    expect(at('install --frozen-lockfile --ignore-scripts')).toBeGreaterThan(
      -1,
    );
    expect(runs.join('\n')).not.toMatch(/\bnx\b/);
    expect(steps.map((s) => s.uses ?? '').join('\n')).not.toContain(
      'upload-artifact',
    );
    // The commands of trinity-ios:sync-prebuilt, in its order.
    const target = JSON.parse(
      readFileSync(resolve(root, 'ios/project.json'), 'utf8'),
    ).targets['sync-prebuilt'].options.commands;
    const sync = steps.findIndex((s) =>
      target.every((command) => s.run?.includes(command)),
    );
    expect(sync).toBeGreaterThan(-1);
    const positions = target.map((command) => steps[sync].run.indexOf(command));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    const key = steps.findIndex(
      (s) => s.run?.includes('"$ASC_KEY_PATH"') && s.run.includes('base64'),
    );
    expect(key).toBeGreaterThan(sync);
    expect(steps[key + 1].name).toBe('Archive');
  });

  it('keeps the renderer artifact for as long as a reviewer may take to approve', () => {
    const artifact = build().steps.find((s) =>
      s.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(artifact.with['retention-days']).toBe(30);
  });

  it('reads secrets only through the signing job step env, never inside a script', () => {
    const workflow = testflight();
    const withoutStepEnv = {
      ...workflow,
      jobs: Object.fromEntries(
        Object.entries(workflow.jobs).map(([id, job]) => [
          id,
          { ...job, steps: job.steps.map(({ env: _env, ...s }) => s) },
        ]),
      ),
    };
    expect(JSON.stringify(withoutStepEnv)).not.toContain('secrets.');
    for (const { run = '' } of upload().steps) {
      expect(run).not.toContain('${{ secrets.');
      expect(run).not.toMatch(/set -\w*x/);
    }
    // The dispatch input and every other expression reach scripts through env.
    for (const job of Object.values(workflow.jobs)) {
      for (const { run = '' } of job.steps) expect(run).not.toContain('${{');
    }
    const tag = build().steps.find((s) => s.id === 'tag');
    expect(tag.env.TAG).toBe('${{ inputs.tag }}');
    const read = JSON.stringify(upload().steps.map((s) => s.env ?? {}));
    for (const name of SECRETS) expect(read).toContain(`secrets.${name}`);
  });

  it('keeps the runner context out of workflow and job env, where it is not allowed', () => {
    const workflow = testflight();
    expect(JSON.stringify(workflow.env ?? {})).not.toContain('runner.');
    for (const job of Object.values(workflow.jobs)) {
      expect(JSON.stringify(job.env ?? {})).not.toContain('runner.');
    }
  });

  it('is the only workflow that reads the mobile secrets', () => {
    // APPLE_TEAM_ID is also a `release` environment secret that release.yml reads.
    for (const file of workflows().filter((name) => name !== FILE)) {
      const text = readFileSync(
        resolve(root, '.github/workflows', file),
        'utf8',
      );
      for (const name of SECRETS.filter((n) => n !== 'APPLE_TEAM_ID')) {
        expect(text, `${file} ${name}`).not.toContain(name);
      }
    }
  });

  it('sets the file paths from RUNNER_TEMP first, and removes the files even when the upload fails', () => {
    const [first] = upload().steps;
    expect(first.run).toContain('$RUNNER_TEMP/AuthKey.p8');
    expect(first.run).toContain('$GITHUB_ENV');
    expect(first.run).toContain('ASC_KEY_PATH=');
    expect(first.run).toContain('PLIST_PATH=');
    const last = upload().steps.at(-1);
    expect(last.if).toBe('always()');
    expect(last.run).toContain('$ASC_KEY_PATH');
    expect(last.run).toContain('$PLIST_PATH');
  });

  it('names every missing secret and fails, without printing a value', () => {
    const check = step(upload(), 'name', 'Mobile secrets are complete');
    for (const name of SECRETS) expect(check.run).toContain(name);
    const env = Object.fromEntries(SECRETS.map((name) => [name, 'x']));
    delete env.ASC_KEY_ID;
    const result = bash(check.run, {
      env: { PATH: process.env.PATH, ...env, ASC_KEY_P8: 'do-not-print' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('ASC_KEY_ID');
    expect(result.stdout + result.stderr).not.toContain('do-not-print');
  });

  it('writes the key and plist with a private umask and checks they decode', () => {
    const write = step(
      upload(),
      'name',
      'Write the Firebase plist and the App Store Connect key',
    );
    expect(write.run).toMatch(/^umask 077$/m);
    expect(write.run).toContain('plutil -lint "$PLIST_PATH"');
    expect(write.run).toContain('-----BEGIN PRIVATE KEY-----');
  });

  describe.skipIf(spawnSync('plutil', ['-help']).error)(
    'decoding the secrets',
    () => {
      const PLIST =
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>';
      const PEM =
        '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
      const b64 = (text) => Buffer.from(text).toString('base64');
      const decode = (plist, key) =>
        inTempDir((dir) => {
          const env = {
            PATH: process.env.PATH,
            PLIST_PATH: join(dir, 'GoogleService-Info.plist'),
            ASC_KEY_PATH: join(dir, 'AuthKey.p8'),
            GOOGLE_SERVICE_INFO_PLIST: plist,
            ASC_KEY_P8: key,
          };
          const script = step(
            upload(),
            'name',
            'Write the Firebase plist and the App Store Connect key',
          ).run;
          const result = bash(script, { env });
          return {
            status: result.status,
            output: result.stdout + result.stderr,
            mode:
              result.status === 0
                ? statSync(env.ASC_KEY_PATH).mode & 0o777
                : null,
          };
        });

      it('accepts a base64 plist and key, leaving the key readable by its owner only', () => {
        const result = decode(b64(PLIST), b64(PEM));
        expect(result.status).toBe(0);
        expect(result.mode).toBe(0o600);
      });

      it('rejects a raw PEM pasted in place of its base64, which macOS would decode silently', () => {
        const result = decode(b64(PLIST), PEM);
        expect(result.status).not.toBe(0);
        expect(result.output).not.toContain('abc');
      });

      it('rejects a plist that is not a plist', () => {
        expect(decode(b64('not a plist'), b64(PEM)).status).not.toBe(0);
      });
    },
  );

  it('exports with an upload that cannot rewrite the build number', () => {
    const exportStep = step(upload(), 'name', 'Export and upload');
    expect(exportStep.run).toContain(
      '<key>destination</key><string>upload</string>',
    );
    expect(exportStep.run).toMatch(
      /<key>manageAppVersionAndBuildNumber<\/key><false\/>/,
    );
  });

  describe('the tag and the dispatch ref', () => {
    const sh = (script, env, options = {}) =>
      inTempDir((dir) => {
        const out = join(dir, 'output');
        const summary = join(dir, 'summary');
        writeFileSync(out, '');
        writeFileSync(summary, '');
        const result = bash(script, {
          cwd: dir,
          ...options,
          env: {
            ...process.env,
            GITHUB_OUTPUT: out,
            GITHUB_STEP_SUMMARY: summary,
            ...env,
          },
        });
        return {
          status: result.status,
          text: result.stdout + result.stderr,
          output: readFileSync(out, 'utf8'),
          summary: readFileSync(summary, 'utf8'),
        };
      });
    const tagStep = () => step(build(), 'id', 'tag').run;
    const run = (tag, runNumber = '42') =>
      sh(tagStep(), { TAG: tag, RUN_NUMBER: runNumber });

    it('runs the ref and tag checks first, before any checkout or build', () => {
      const [first, second, third] = build().steps;
      expect(first.env.REF).toBe('${{ github.ref }}');
      expect(second.id).toBe('tag');
      expect(third.uses).toMatch(/^actions\/checkout@/);
      expect(third.with['fetch-depth']).toBe(0);
    });

    it('accepts only a dispatch from main', () => {
      const script = build().steps[0].run;
      expect(sh(script, { REF: 'refs/heads/main' }).status).toBe(0);
      for (const ref of [
        'refs/heads/release/0.6.x',
        'refs/tags/v0.6.0-next.6',
        'refs/heads/main\nx',
      ]) {
        const result = sh(script, { REF: ref });
        expect(result.status, ref).not.toBe(0);
        expect(result.text, ref).toContain('main');
      }
    });

    it('takes the marketing version from the tag and the build number from the run number', () => {
      const result = run('v0.6.0-next.6');
      expect(result.status).toBe(0);
      expect(result.output).toContain('tag=v0.6.0-next.6\n');
      expect(result.output).toContain('marketing=0.6.0\n');
      expect(result.output).toContain('build=42\n');
      expect(result.summary).toContain('0.6.0');
      expect(result.summary).toContain('42');
    });

    it('refuses everything but a next tag, naming the problem', () => {
      for (const bad of [
        '0.6.0-next.6',
        'v1.2.3',
        'v1.2.3+meta',
        'v1.2.3-rc.1',
        'v1.2.3-next.1;x',
        'v1.2.3-next.1\n',
        'v1.2.3-next.1\nv1.2.3-next.2',
        '',
        'junk',
      ]) {
        const result = run(bad);
        expect(result.status, JSON.stringify(bad)).not.toBe(0);
        expect(result.output, JSON.stringify(bad)).toBe('');
        expect(result.text, JSON.stringify(bad)).toContain('-next.');
      }
    });

    it('fails on a run number that is not an integer', () => {
      expect(run('v0.6.0-next.6', 'abc').status).not.toBe(0);
    });

    it('requires package.json at the tagged commit to equal the tag', () => {
      const script = step(build(), 'name', 'Tag matches package.json').run;
      const at = (version, tag) =>
        inTempDir((dir) => {
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
          return bash(script, { cwd: dir, env: { ...process.env, TAG: tag } })
            .status;
        });
      expect(at('0.6.0-next.6', 'v0.6.0-next.6')).toBe(0);
      expect(at('0.6.0-next.7', 'v0.6.0-next.6')).not.toBe(0);
    });

    it('refuses a tagged commit without the privacy manifest, which an older tag lacks', () => {
      const script = step(
        build(),
        'name',
        'Tagged commit has the iOS privacy manifest',
      ).run;
      const at = (create) =>
        inTempDir((dir) => {
          if (create) {
            mkdirSync(join(dir, 'ios/App/App'), { recursive: true });
            writeFileSync(join(dir, 'ios/App/App/PrivacyInfo.xcprivacy'), '');
          }
          const result = bash(script, {
            cwd: dir,
            env: { ...process.env, TAG: 'v0.6.0-next.5' },
          });
          return { status: result.status, text: result.stdout + result.stderr };
        });
      expect(at(true).status).toBe(0);
      const missing = at(false);
      expect(missing.status).not.toBe(0);
      expect(missing.text).toContain('v0.6.0-next.5');
      expect(missing.text).toContain('PrivacyInfo.xcprivacy');
    });

    describe('the tagged commit is on main', () => {
      const script = () =>
        step(build(), 'name', 'Tagged commit is on main').run;
      const git = (cwd, ...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
          { cwd, encoding: 'utf8' },
        );
      const check = (onMain) =>
        inTempDir((dir) => {
          const origin = join(dir, 'origin');
          const clone = join(dir, 'clone');
          mkdirSync(origin);
          git(origin, 'init', '-q', '-b', 'main');
          git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
          git(origin, 'checkout', '-q', '-b', 'side');
          git(origin, 'commit', '-q', '--allow-empty', '-m', 'unmerged');
          git(origin, 'tag', 'v0.6.0-next.9');
          if (onMain)
            (git(origin, 'checkout', '-q', 'main', '--'),
              git(origin, 'merge', '-q', 'side'));
          git(dir, 'clone', '-q', origin, clone);
          git(clone, 'checkout', '-q', 'refs/tags/v0.6.0-next.9');
          const result = bash(script(), {
            cwd: clone,
            env: { ...process.env, TAG: 'v0.6.0-next.9' },
          });
          return { status: result.status, text: result.stdout + result.stderr };
        });

      it('passes a tag on main and fails one that is not', () => {
        expect(check(true).status).toBe(0);
        const off = check(false);
        expect(off.status).not.toBe(0);
        expect(off.text).toContain('v0.6.0-next.9');
      });
    });
  });
});
