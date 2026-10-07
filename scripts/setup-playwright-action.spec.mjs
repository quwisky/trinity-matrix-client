/** Playwright's host packages come from an actions cache so a slow mirror cannot time the install out. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const action = parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '..',
      '.github/actions/setup-playwright/action.yml',
    ),
    'utf8',
  ),
);
const steps = action.runs.steps;
const aptCache = steps.findIndex((step) =>
  String(step.with?.path ?? '').includes('apt'),
);

describe('setup-playwright apt archive cache', () => {
  it('restores the apt cache before any install path', () => {
    const install = steps.findIndex((step) =>
      String(step.run ?? '').includes('playwright install'),
    );
    expect(aptCache).toBeGreaterThan(-1);
    expect(steps[aptCache].uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
    expect(aptCache).toBeLessThan(install);
    // Not gated on the install input: ci-prerequisites installs too.
    expect(steps[aptCache].if).not.toContain('inputs.install');
  });

  it('keys on the runner image, the browsers and the lockfile', () => {
    const { key, 'restore-keys': restoreKeys } = steps[aptCache].with;
    for (const part of [
      'runner.os',
      'steps.apt.outputs.image',
      'inputs.browsers',
      "hashFiles('pnpm-lock.yaml')",
    ]) {
      expect(key).toContain(part);
    }
    expect(restoreKeys).toBe(
      key.replace("${{ hashFiles('pnpm-lock.yaml') }}", ''),
    );
    const prepare = steps.find((step) => step.id === 'apt');
    expect(prepare.run).toContain('ImageOS');
    expect(prepare.run).toContain('ImageVersion');
  });

  it('points apt at a user-owned archive directory that keeps the packages', () => {
    const prepare = steps.find((step) =>
      String(step.run ?? '').includes('Dir::Cache::Archives'),
    );
    expect(steps.indexOf(prepare)).toBeLessThan(aptCache);
    expect(prepare.run).toContain('Keep-Downloaded-Packages');
  });
});

describe('setup-playwright install attempts', () => {
  const install = steps.find((step) =>
    String(step.run ?? '').includes('playwright install'),
  );

  it('bounds each attempt to six minutes and retries once', () => {
    expect(install.run).toMatch(
      /timeout (-k \d+ )?360 pnpm exec playwright install/,
    );
    expect(install.run).toContain(
      '::warning::playwright install attempt 1 failed (rc=$rc); retrying',
    );
    expect(install.run).toMatch(/for attempt in 1 2/);
    // The second attempt's status is the step's status.
    expect(install.run).toMatch(/exit "\$rc"/);
  });

  it('fails with the second attempt exit status when both attempts fail', () => {
    const script = install.run.replace(
      /timeout (-k \d+ )?360 pnpm exec playwright install/g,
      'fake-install',
    );
    const run = (counterStart) =>
      spawnSync(
        'bash',
        [
          '-c',
          `fake-install() { n=$((n+1)); [ $n -le ${counterStart} ] && return $((n+40)); return 0; }; ${script}`,
        ],
        {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS: 'chromium',
            WITH_DEPS: 'true',
          },
          encoding: 'utf8',
        },
      );
    expect(run(0).status).toBe(0);
    const once = run(1);
    expect(once.status).toBe(0);
    expect(once.stdout).toContain('attempt 1 failed (rc=41); retrying');
    expect(run(2).status).toBe(42);
  });
});
