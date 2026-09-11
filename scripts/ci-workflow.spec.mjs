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
      '${{ matrix.shard == 3 && 180 || matrix.shard == 4 && 120 || 100 }}',
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
    expect(uploads.length).toBe(15);
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

    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(() => execFileSync('sh', ['-n', '-c', line])).not.toThrow();
    }
  });
});
