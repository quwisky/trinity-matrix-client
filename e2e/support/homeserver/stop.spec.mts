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

  it('names the MAS and call services in the Docker teardown, whatever is selected', async () => {
    const state = await mkdtemp(join(tmpdir(), 'homeserver-stop-'));
    const commands: string[][] = [];
    try {
      vi.doMock('node:child_process', () => ({
        execFile: (
          command: string,
          args: string[],
          _options: unknown,
          callback: (error: null, result: object) => void,
        ) => {
          commands.push([command, ...args]);
          callback(null, { stdout: '', stderr: '' });
        },
      }));
      vi.stubEnv('TRINITY_E2E_STATE_DIR', state);
      vi.stubEnv('TRINITY_E2E_NETWORK_CONTAINER', '');
      vi.stubEnv('TRINITY_E2E_HOMESERVER', 'synapse');
      vi.stubEnv('TRINITY_E2E_CALLS', '');
      vi.stubEnv('TRINITY_E2E_HOMESERVER_RUNTIME', 'docker');
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { stop } = await import('./stop.mjs');

      await stop();

      const down = commands.find((command) => command.includes('down'));
      const files = down?.filter((_, i) => down[i - 1] === '-f') ?? [];
      expect(
        files.map((file) => file.slice(join(import.meta.dirname, '/').length)),
      ).toEqual([
        'docker-compose.yml',
        'synapse/docker-compose.yml',
        'mas/docker-compose.yml',
        'calls/docker-compose.yml',
      ]);
      expect(down).toEqual(
        expect.arrayContaining(['down', '-v', '--remove-orphans']),
      );
    } finally {
      vi.doUnmock('node:child_process');
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
