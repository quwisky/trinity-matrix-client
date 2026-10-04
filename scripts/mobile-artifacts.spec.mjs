import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyHomeserverLogs } from '../e2e/mobile/support/artifacts.mts';

describe('native homeserver log capture', () => {
  it('copies only the existing log files, never caddy-data', () => {
    const root = mkdtempSync(join(tmpdir(), 'hs-logs-'));
    const data = join(root, 'data');
    mkdirSync(join(data, 'caddy-data'), { recursive: true });
    writeFileSync(join(data, 'caddy-data', 'root.key'), 'secret');
    writeFileSync(join(data, 'synapse.out.log'), 'synapse');
    const dest = join(root, 'out');
    writeFileSync(join(data, 'homeserver.log'), 'synapse file log');
    copyHomeserverLogs(
      [
        join(data, 'synapse.out.log'),
        join(data, 'homeserver.log'),
        join(data, 'caddy.log'),
      ],
      dest,
    );
    expect(readdirSync(dest).sort()).toEqual([
      'homeserver.log',
      'synapse.out.log',
    ]);
  });
});
