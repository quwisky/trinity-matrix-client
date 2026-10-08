import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('stop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the PID file when the native stop fails', async () => {
    const state = await mkdtemp(join(tmpdir(), 'homeserver-stop-'));
    try {
      const pidFile = join(state, 'data', 'native-pids.json');
      await mkdir(join(state, 'data'), { recursive: true });
      await writeFile(pidFile, '{not json', 'utf8');
      vi.stubEnv('TRINITY_E2E_STATE_DIR', state);
      vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
      vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'native');
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { stop } = await import('./stop.mjs');

      await expect(stop()).rejects.toThrow('Homeserver teardown failed');
      await expect(access(pidFile)).resolves.toBeUndefined();
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  it('removes the generated MAS state', async () => {
    const state = await mkdtemp(join(tmpdir(), 'homeserver-stop-'));
    try {
      const generated = join(state, 'mas-data', 'mas', 'generated.yaml');
      await mkdir(join(state, 'mas-data', 'mas'), { recursive: true });
      await writeFile(generated, 'secrets: {}\n', 'utf8');
      vi.stubEnv('TRINITY_E2E_STATE_DIR', state);
      vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
      vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'native');
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { stop } = await import('./stop.mjs');

      await stop();

      await expect(access(generated)).rejects.toThrow();
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
