/** Production consumers share a verified renderer; intentional development builds stay independent. */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const yaml = (path) => parse(read(path));
const json = (path) => JSON.parse(read(path));
const ci = yaml('.github/workflows/ci.yml');
const renderer = yaml('.github/workflows/_renderer.yml');
const restore = yaml('.github/actions/restore-verified-renderer/action.yml');
const usesRestore = (step) =>
  step.uses === './.github/actions/restore-verified-renderer';

describe('verified renderer workflow boundary', () => {
  it('builds production exactly once through one same-commit reusable layer', () => {
    expect(ci.jobs.renderer.uses).toBe('./.github/workflows/_renderer.yml');
    expect(ci.jobs.renderer.with.sha).toBe('${{ github.sha }}');
    expect(ci.jobs.renderer.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(renderer.on)).toEqual(['workflow_call']);
    expect(Object.keys(renderer.jobs)).toEqual(['renderer']);
    const job = renderer.jobs.renderer;
    expect(job.uses).toBeUndefined();
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.steps[0].with.ref).toBe('${{ inputs.sha }}');
    expect(
      job.steps.filter((step) => step.run?.includes('nx build trinity')),
    ).toEqual([
      {
        run: 'pnpm nx build trinity --configuration=production --skipNxCache',
      },
    ]);
    expect(job.steps.find((step) => step.id === 'manifest').run).toBe(
      'pnpm nx run scripts:record-renderer',
    );
    const upload = job.steps.find((step) => step.id === 'upload');
    expect(upload.with.path.split('\n').filter(Boolean)).toEqual([
      'www/',
      'dist/web-bundle-manifest.json',
      'dist/web-bundle-manifest.json.sha256',
    ]);
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    for (const identity of [
      'github.run_id',
      'github.run_attempt',
      'github.sha',
    ]) {
      expect(ci.jobs.renderer.with['artifact-name']).toContain(identity);
    }
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '').not.toMatch(
          /pnpm build|nx (?:build trinity|run trinity:build:production)/,
        );
      }
    }
  });

  it.each(['desktop', 'e2e', 'android-e2e', 'ios-native-build'])(
    'restores explicit coordinates before %s consumes production',
    (id) => {
      const job = ci.jobs[id];
      expect(job.needs).toContain('renderer');
      expect(job.if).toContain("needs.renderer.result == 'success'");
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read' });
      expect(job.environment).toBeUndefined();
      const action = job.steps.find(usesRestore);
      expect(action.with).toEqual({
        sha: '${{ needs.renderer.outputs.sha }}',
        'source-run-id': '${{ github.run_id }}',
        'artifact-id': '${{ needs.renderer.outputs.artifact-id }}',
        'artifact-name': '${{ needs.renderer.outputs.artifact-name }}',
        'manifest-digest': '${{ needs.renderer.outputs.manifest-digest }}',
        destination: 'dist/renderer-download',
      });
      expect(job.steps[0].with.ref).toBe('${{ needs.renderer.outputs.sha }}');
    },
  );

  it('validates metadata before download and publishes prebuilt mode only after verification', () => {
    const steps = restore.runs.steps;
    expect(steps[0].run).toBe('node scripts/renderer-artifact.mjs prepare');
    expect(steps[1].with['artifact-ids']).toBe('${{ inputs.artifact-id }}');
    expect(steps[1].with['run-id']).toBe('${{ inputs.source-run-id }}');
    expect(steps[1].with.name).toBeUndefined();
    expect(steps[2].run).toBe('node scripts/renderer-artifact.mjs restore');
    expect(JSON.stringify(restore)).not.toContain('TRINITY_E2E_PREBUILT_WWW=1');
  });

  it('restores production after development prerequisites and preserves development builds', () => {
    const steps = ci.jobs.e2e.steps;
    const restored = steps.findIndex(usesRestore);
    expect(restored).toBeGreaterThan(
      steps.findIndex((step) => step.id === 'prerequisites'),
    );
    expect(restored).toBeLessThan(
      steps.findIndex((step) => step.id === 'renderer'),
    );
    expect(read('scripts/ci-prerequisites.mjs')).toContain(
      'trinity:build:development',
    );
    expect(
      json('e2e/components/project.json').targets.styling.options.command,
    ).toContain('--build=trinity:build:development');
    expect(read('e2e/support/run-playwright.mts')).toContain(
      "options.bundleManifest && environment['TRINITY_E2E_PREBUILT_WWW'] === '1'",
    );
    expect(
      ci.jobs.desktop.steps.find((step) => step.id === 'electron').run,
    ).toContain('pnpm nx run trinity-e2e-electron:full-prebuilt');
    expect(read('e2e/android/run.mts')).toContain(
      'Android CI requires the verified prebuilt renderer',
    );
  });

  it('compiles iOS unsigned on the selected macOS toolchain and retains failure diagnostics', () => {
    const job = ci.jobs['ios-native-build'];
    expect(job['runs-on']).toBe('macos-26');
    expect(
      job.steps.some((step) => step.run?.includes('xcodebuild -version')),
    ).toBe(true);
    expect(
      job.steps.some((step) =>
        step.run?.includes('xcrun --sdk iphonesimulator --show-sdk-version'),
      ),
    ).toBe(true);
    expect(job.steps.find((step) => step.id === 'ios').run).toContain(
      'nx run trinity-ios:build-prebuilt',
    );
    const pushTests = job.steps.findIndex(
      (step) => step.id === 'ios-push-tests',
    );
    expect(pushTests).toBeGreaterThan(-1);
    expect(pushTests).toBeLessThan(
      job.steps.findIndex((step) => step.id === 'ios'),
    );
    expect(job.steps[pushTests].run).toContain('set -o pipefail');
    expect(job.steps[pushTests].run).toContain(
      'pnpm nx run trinity-ios:test-push-registration',
    );
    expect(
      json('ios/project.json').targets['test-push-registration'].options
        .command,
    ).toBe(
      'swift test --package-path ios/PushRegistration --scratch-path dist/ios-native/push-registration',
    );
    const upload = job.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.if).toContain(
      "!cancelled() && (steps.ios.outputs.started == 'true' || steps.ios-push-tests.outputs.started == 'true')",
    );
    expect(upload.with.path).toContain('push-registration-tests.log');
    expect(upload.with.path).toContain('xcodebuild.log');
    expect(upload.with.path).toContain('build.xcresult');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(job.steps.at(-1).run).toBe('git diff --exit-code');
  });

  it('pins external actions and keeps the reusable workflow and composite unprivileged', () => {
    for (const document of [renderer, restore]) {
      expect(JSON.stringify(document)).not.toMatch(
        /secrets|id-token|packages|environment/,
      );
      const steps =
        document.runs?.steps ??
        Object.values(document.jobs).flatMap((job) => job.steps);
      for (const step of steps) {
        if (step.uses && !step.uses.startsWith('./'))
          expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      }
    }
  });
});

describe('prebuilt host target contracts', () => {
  it('preserves prior Xcode results when the local prebuilt compiler is invoked twice', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-ios-command-'));
    try {
      const cwd = join(directory, 'ios');
      mkdirSync(cwd);
      const compiler = join(directory, 'xcodebuild');
      // Exercise the actual shell command, substituting only the unavailable compiler.
      writeFileSync(
        compiler,
        '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = process.argv[process.argv.indexOf("-resultBundlePath") + 1]; fs.mkdirSync(path); fs.appendFileSync(process.env.XCODE_TEST_PATHS, path + "\\n");\n',
      );
      chmodSync(compiler, 0o755);
      const paths = join(directory, 'paths');
      const command =
        json('ios/project.json').targets['build-prebuilt'].options.command;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        execFileSync('bash', ['-c', command], {
          cwd,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            XCODE_TEST_PATHS: paths,
          },
        });
      }
      const results = readFileSync(paths, 'utf8').trim().split('\n');
      expect(new Set(results).size).toBe(2);
      expect(results.every((path) => existsSync(resolve(cwd, path)))).toBe(
        true,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['android', 'ios'])(
    '%s verifies both original and copied payload without a renderer dependency',
    (host) => {
      const targets = json(`${host}/project.json`).targets;
      const sync = targets['sync-prebuilt'];
      expect(sync.dependsOn ?? []).toEqual([]);
      expect(sync.cache).toBe(false);
      expect(sync.options.parallel).toBe(false);
      const copied =
        host === 'ios'
          ? 'ios/App/App/public'
          : 'android/app/src/main/assets/public';
      expect(sync.options.commands).toEqual([
        'node scripts/web-bundle-manifest.mjs verify dist/web-bundle-manifest.json www',
        `pnpm exec cap sync ${host}`,
        `node scripts/web-bundle-manifest.mjs verify-with-extras dist/web-bundle-manifest.json ${copied} cordova.js cordova_plugins.js`,
      ]);
      expect(targets['build-prebuilt'].dependsOn).toEqual(['sync-prebuilt']);
      if (host === 'ios') {
        expect(targets['build-prebuilt'].options.command).toContain(
          '-sdk iphonesimulator',
        );
        expect(targets['build-prebuilt'].options.command).toContain(
          'CODE_SIGNING_ALLOWED=NO',
        );
      }
    },
  );

  it('gives Electron prebuilt E2E a verified shell path without a production build dependency', () => {
    const host = json('electron/project.json').targets['build-prebuilt'];
    expect(host.dependsOn).toEqual([
      'install',
      { projects: ['scripts'], target: 'verify-renderer' },
    ]);
    for (const name of ['full-prebuilt', 'smoke-prebuilt']) {
      const target = json('e2e/electron/project.json').targets[name];
      expect(target.dependsOn).toEqual([
        { projects: ['trinity-desktop'], target: 'build-prebuilt' },
      ]);
      expect(target.options.command).toMatch(
        /^node scripts\/web-bundle-manifest.mjs verify dist\/web-bundle-manifest.json electron\/www && node e2e\/support\/run-playwright.mts/,
      );
    }
  });
});
