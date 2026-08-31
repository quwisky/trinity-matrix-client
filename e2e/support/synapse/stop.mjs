// Tears the disposable Synapse + Caddy + Dex stack down and removes generated state.
//
// `docker compose down -v` stops every container and drops the named volumes
// (Caddy CA/data). The generated ./data (homeserver.yaml, signing key, sqlite DB)
// is removed too so the next run starts from a clean slate.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  DATA,
  REMOTE_DATA,
  composeFiles,
  resolveNetworkContainer,
} from './paths.mjs';
import { acquireSynapseTeardownLease, releaseSynapseLease } from './lease.mts';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[synapse] ${m}`);

export async function stop({ keepData = false, signal } = {}) {
  const failures = [];
  try {
    // Detection failing must not strand the stack: fall back to the default file set.
    const networkContainer = await resolveNetworkContainer().catch(() => '');
    log('docker compose down…');
    await exec(
      'docker',
      [
        'compose',
        ...composeFiles(networkContainer),
        'down',
        '-v',
        '--remove-orphans',
      ],
      {
        cwd: HERE,
        signal,
        env: {
          ...process.env,
          TRINITY_E2E_NETWORK_CONTAINER: networkContainer,
        },
      },
    );
  } catch (err) {
    log(`compose down failed: ${err.message ?? err}`);
    failures.push(err);
  }
  if (!keepData) {
    try {
      await Promise.all([
        rm(DATA, { recursive: true, force: true }),
        rm(REMOTE_DATA, { recursive: true, force: true }),
      ]);
      log('removed ./data and ./remote-data');
    } catch (err) {
      failures.push(err);
    }
  }
  log('down.');
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Synapse teardown failed');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let lease;
  try {
    lease = acquireSynapseTeardownLease();
    await stop({ keepData: process.argv.includes('--keep-data') });
  } catch (err) {
    console.error('[synapse] stop failed:', err);
    process.exitCode = 1;
  } finally {
    releaseSynapseLease(lease);
  }
}
