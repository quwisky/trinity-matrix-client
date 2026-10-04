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
    vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
    vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'native');
    const { acquireHomeserverLease, homeserverLockFile } =
      await import('./lease.mts');

    await expect(acquireHomeserverLease()).rejects.toThrow(
      /already running \(homeserver/,
    );
    expect(existsSync(homeserverLockFile)).toBe(false);
  });
});
