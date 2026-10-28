import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('homeserver lease', () => {
  let state: string | undefined;
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill('SIGKILL');
    child = undefined;
    if (state) rmSync(state, { recursive: true, force: true });
    state = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses while a native process of ours lives, and releases its lock', async () => {
    state = mkdtempSync(join(tmpdir(), 'homeserver-lease-'));
    mkdirSync(join(state, 'data'), { recursive: true });
    // A stand-in whose command line matches the Synapse identity check.
    child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e6)', 'synapse.app.homeserver'],
      { stdio: 'ignore' },
    );
    writeFileSync(
      join(state, 'data', 'native-pids.json'),
      JSON.stringify({ homeserver: child.pid }),
    );
    vi.stubEnv('TRINITY_E2E_STATE_DIR', state);
    vi.stubEnv('HOME', state);
    vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
    vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'native');
    const {
      acquireHomeserverLease,
      homeserverLockFile,
      homeserverPortLockFile,
    } = await import('./lease.mts');

    await expect(acquireHomeserverLease()).rejects.toThrow(
      /already running \(homeserver/,
    );
    expect(existsSync(homeserverLockFile)).toBe(false);
    expect(existsSync(homeserverPortLockFile)).toBe(false);
  });

  it('takes turns with another checkout on the same offset, not on another', async () => {
    state = mkdtempSync(join(tmpdir(), 'homeserver-lease-'));
    vi.stubEnv('HOME', state);
    vi.stubEnv('TRINITY_E2E_STATE_DIR', state);
    vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
    vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'native');
    vi.stubEnv('TRINITY_E2E_PORT_OFFSET', '100');
    const lease = await import('./lease.mts');
    expect(lease.homeserverPortLockFile).toBe(
      join(state, '.cache/trinity-e2e/homeserver-100.lock'),
    );
    // Another checkout's live run on offset 100: this process's parent stands in for it.
    mkdirSync(join(state, '.cache/trinity-e2e'), { recursive: true });
    writeFileSync(
      lease.homeserverPortLockFile,
      JSON.stringify({ pid: process.ppid, nonce: 'other', createdAt: 'now' }),
    );
    await expect(lease.acquireHomeserverLease()).rejects.toThrow(
      /on TRINITY_E2E_PORT_OFFSET=100 is already running as PID/,
    );
    expect(existsSync(lease.homeserverLockFile)).toBe(false);

    vi.stubEnv('TRINITY_E2E_PORT_OFFSET', '200');
    vi.resetModules();
    const other = await import('./lease.mts');
    const owned = await other.acquireHomeserverLease();
    expect(existsSync(other.homeserverPortLockFile)).toBe(true);
    other.releaseHomeserverLease(owned);
    expect(existsSync(other.homeserverPortLockFile)).toBe(false);
    expect(existsSync(other.homeserverLockFile)).toBe(false);
  });

  it('rejects a bad TRINITY_E2E_MAS before a lock exists', async () => {
    vi.stubEnv('TRINITY_E2E_MAS', 'yes');
    const { acquireHomeserverLease, homeserverLockFile } =
      await import('./lease.mts');

    await expect(acquireHomeserverLease()).rejects.toThrow(/TRINITY_E2E_MAS/);
    expect(existsSync(homeserverLockFile)).toBe(false);
  });
});
