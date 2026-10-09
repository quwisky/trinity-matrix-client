import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand, runPrerequisites } from './ci-prerequisites.mjs';

const tempDirs = [];
const node = process.execPath;
const fixture = (source) => [node, ['--input-type=module', '-e', source]];
const makeLogDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-ci-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('runCommand', () => {
  it('retains labeled stdout/stderr and the nonzero exit code', async () => {
    const result = await runCommand({
      command: node,
      args: [
        '--input-type=module',
        '-e',
        "console.log('ready'); console.error('bad'); process.exit(7)",
      ],
      label: 'fixture',
      logDir: makeLogDir(),
    });

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('ready');
    expect(result.stderr).toContain('bad');
    expect(readFileSync(result.logFile, 'utf8')).toContain(
      '[fixture] stdout: ready',
    );
  });

  it('reports a successful child', async () => {
    const [command, args] = fixture("process.stdout.write('ok\\n')");
    await expect(
      runCommand({ command, args, label: 'ok', logDir: makeLogDir() }),
    ).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
  });

  it('terminates and reaps a timed out process group', async () => {
    const marker = join(makeLogDir(), 'descendant-alive');
    const descendantSource = `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 5000)`;
    const source = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendantSource)}], { detached: false });
      writeFileSync(${JSON.stringify(`${marker}.pid`)}, String(child.pid));
      child.on('error', () => {});
      setInterval(() => {}, 1000);
    `;
    const result = await runCommand({
      command: node,
      args: ['--input-type=module', '-e', source],
      label: 'timeout',
      logDir: makeLogDir(),
      timeoutMs: 300,
      killGraceMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    const childPid = Number(readFileSync(`${marker}.pid`, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('settles when signalling the reaped group reports EPERM, as macOS does for zombies', async () => {
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    try {
      const result = await runCommand({
        command: node,
        args: ['-e', '0'],
        label: 'eperm',
        logDir: makeLogDir(),
      });
      expect(result.exitCode).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    } finally {
      spy.mockRestore();
    }
  });

  it('aborts a running process group and reports cancellation', async () => {
    const controller = new AbortController();
    const promise = runCommand({
      command: node,
      args: ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'],
      label: 'abort',
      logDir: makeLogDir(),
      abortSignal: controller.signal,
      killGraceMs: 100,
      onSpawn: () => controller.abort(),
    });
    await expect(promise).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
    });
  });
});

describe('runPrerequisites', () => {
  it('keeps optional docker failure from masking mandatory failures', async () => {
    const outcomes = await runPrerequisites({
      logDir: makeLogDir(),
      run: async ({ label }) => ({
        label,
        exitCode:
          label === 'docker-pull'
            ? 19
            : label === 'playwright-install'
              ? 23
              : 0,
        signal: null,
        timedOut: false,
        aborted: false,
      }),
    });

    expect(outcomes.exitCode).toBe(23);
    expect(outcomes.docker.warning).toContain('19');
    expect(outcomes.playwright.exitCode).toBe(23);
    expect(outcomes.build.exitCode).toBe(0);
  });

  it.each([
    [{}, 'tuwunel'],
    [{ TRINITY_E2E_HOMESERVER: 'synapse' }, 'synapse'],
  ])(
    'pre-pulls the images of the selected homeserver (%o)',
    async (env, kind) => {
      const calls = [];
      await runPrerequisites({
        logDir: makeLogDir(),
        env,
        run: async (spec) => {
          calls.push(spec);
          return { label: spec.label, exitCode: 0, signal: null };
        },
      });
      const pull = calls.find(({ label }) => label === 'docker-pull');
      const files = pull.args.filter((_, i) => pull.args[i - 1] === '-f');
      expect(files).toEqual([
        'e2e/support/homeserver/docker-compose.yml',
        `e2e/support/homeserver/${kind}/docker-compose.yml`,
      ]);
      for (const file of files) {
        expect(existsSync(join(import.meta.dirname, '..', file))).toBe(true);
      }
    },
  );

  it.each([
    [{}, ['chromium', 'webkit']],
    [{ TRINITY_PLAYWRIGHT_BROWSERS: 'chromium' }, ['chromium']],
    [
      { TRINITY_PLAYWRIGHT_BROWSERS: ' chromium  firefox ' },
      ['chromium', 'firefox'],
    ],
  ])(
    'installs the selected Playwright browsers (%o)',
    async (env, browsers) => {
      const calls = [];
      await runPrerequisites({
        logDir: makeLogDir(),
        env,
        run: async (spec) => {
          calls.push(spec);
          return { label: spec.label, exitCode: 0, signal: null };
        },
      });
      const install = calls.find(({ label }) => label === 'playwright-install');
      expect(install.args).toEqual([
        'exec',
        'playwright',
        'install',
        '--with-deps',
        ...browsers,
      ]);
    },
  );

  describe('playwright-install attempts', () => {
    const sixMinutes = 6 * 60 * 1000;
    const attempts = async (exitCodes, extra = {}) => {
      const calls = [];
      const warnings = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((line) => {
        warnings.push(line);
      });
      try {
        const outcome = await runPrerequisites({
          logDir: makeLogDir(),
          timeoutMs: 1234,
          run: async (spec) => {
            calls.push(spec);
            const install = spec.label === 'playwright-install';
            const exitCode = install ? (exitCodes.shift() ?? 0) : 0;
            return {
              label: spec.label,
              exitCode,
              signal: null,
              timedOut: install && exitCode === 124,
              aborted: false,
              ...extra,
            };
          },
        });
        return { outcome, calls, warnings };
      } finally {
        warn.mockRestore();
      }
    };

    it('bounds each attempt to six minutes and keeps the other timeouts', async () => {
      const { calls } = await attempts([0]);
      const byLabel = Object.fromEntries(
        calls.map(({ label, timeoutMs }) => [label, timeoutMs]),
      );
      expect(byLabel).toEqual({
        'playwright-install': sixMinutes,
        'docker-pull': 1234,
        'development-build': 1234,
      });
    });

    it('retries once after a failed attempt and logs the retry', async () => {
      const { outcome, calls, warnings } = await attempts([23, 0]);
      expect(
        calls.filter(({ label }) => label === 'playwright-install'),
      ).toHaveLength(2);
      expect(outcome.exitCode).toBe(0);
      expect(warnings).toContain(
        '::warning::playwright install attempt 1 failed (rc=23); retrying',
      );
    });

    it('reports the second attempt when both fail, including a timeout', async () => {
      const { outcome, calls } = await attempts([23, 124, 0]);
      expect(
        calls.filter(({ label }) => label === 'playwright-install'),
      ).toHaveLength(2);
      expect(outcome.exitCode).toBe(124);
    });

    it('does not retry a cancelled install', async () => {
      const { calls } = await attempts([143], { aborted: true });
      expect(
        calls.filter(({ label }) => label === 'playwright-install'),
      ).toHaveLength(1);
    });
  });

  it.each([
    [{}, true],
    [{ TRINITY_PLAYWRIGHT_WITH_DEPS: 'true' }, true],
    [{ TRINITY_PLAYWRIGHT_WITH_DEPS: 'false' }, false],
    // Never inferred from the browser list.
    [{ TRINITY_PLAYWRIGHT_BROWSERS: 'chromium' }, true],
  ])('passes --with-deps only unless opted out (%o)', async (env, withDeps) => {
    const calls = [];
    await runPrerequisites({
      logDir: makeLogDir(),
      env,
      run: async (spec) => {
        calls.push(spec);
        return { label: spec.label, exitCode: 0, signal: null };
      },
    });
    const install = calls.find(({ label }) => label === 'playwright-install');
    expect(install.args.includes('--with-deps')).toBe(withDeps);
  });
});
