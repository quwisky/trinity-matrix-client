import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
});
