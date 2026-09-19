import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeElectronHost, openElectronSession } from './electron-session.mts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function ownedChild(source: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`child was not ready: ${output}`)),
      2_000,
    );
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function inspector(
  send: (method: string, params: unknown) => Promise<unknown>,
) {
  return { send, close() {} };
}

describe('Electron session ownership', () => {
  it('cleans a real child and owned profile after inspector evaluation failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-electron-close-'));
    directories.push(directory);
    const profile = join(directory, 'owned-profile');
    mkdirSync(profile);
    writeFileSync(join(profile, 'storage-marker'), 'owned storage');
    const child = await ownedChild(
      "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000);",
    );
    const failure = inspector(async () => ({
      exceptionDetails: { text: 'flush failed' },
    }));
    await expect(
      closeElectronHost(undefined, failure, child, profile, 50),
    ).rejects.toThrow('Electron app.quit evaluation failed');
    await waitForExit(child);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
    expect(existsSync(profile)).toBe(false);
  });

  it('force kills a child that refuses graceful quit and reports the deadline', async () => {
    const child = await ownedChild(
      "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000);",
    );
    const success = inspector(async () => ({ result: { value: true } }));
    await expect(
      closeElectronHost(undefined, success, child, undefined, 50),
    ).rejects.toThrow(
      'Electron app.quit did not exit within the cleanup timeout',
    );
    await waitForExit(child);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });

  it('accepts graceful quit when the owned child exits after the inspector request', async () => {
    const child = await ownedChild(
      "process.stdout.write('READY\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
    );
    const graceful = inspector(async () => {
      child.kill('SIGTERM');
      return { result: { value: true } };
    });
    await expect(
      closeElectronHost(undefined, graceful, child, undefined, 500),
    ).resolves.toBeUndefined();
    await waitForExit(child);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });

  it('preserves a caller-owned profile after startup failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-electron-profile-'));
    directories.push(directory);
    const profile = join(directory, 'caller-profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'keep'), 'caller-owned');
    await expect(
      openElectronSession({
        workspace: process.cwd(),
        artifact: '/does/not/exist/app',
        profile,
        binaryPaths: {
          electron: '/does/not/exist/electron',
          chromedriver: '/does/not/exist/chromedriver',
        },
        inspectorPort: 39_998,
        closeTimeoutMs: 50,
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(profile, 'keep'), 'utf8')).toBe('caller-owned');
  });

  it('does not start a host after pre-cancelled startup', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    await expect(
      openElectronSession({
        workspace: process.cwd(),
        artifact: '/does/not/exist/app',
        binaryPaths: {
          electron: '/does/not/exist/electron',
          chromedriver: '/does/not/exist/chromedriver',
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by test');
  });
});
