// Tears the disposable homeserver + Caddy + Dex stack down and removes generated state.
//
// `docker compose down -v --remove-orphans` stops every container of the project — also
// one of the other homeserver kind, left by a run with a different TRINITY_E2E_HOMESERVER
// — and drops the named volumes (Caddy CA/data). ./data and ./remote-data (generated
// config, signing keys, databases) are removed too, so the next run starts from a clean
// slate: a Tuwunel database is bound to its server_name for life.
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
import { HOMESERVER_KINDS, resolveHomeserverKind } from './kind.mts';
import {
  acquireHomeserverTeardownLease,
  releaseHomeserverLease,
} from './lease.mts';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[homeserver] ${m}`);

/** The selected kind's file set; a bad selection must not strand a running stack. */
function teardownKind() {
  try {
    return resolveHomeserverKind();
  } catch {
    return HOMESERVER_KINDS[0];
  }
}

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
        ...composeFiles(teardownKind(), networkContainer),
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
    throw new AggregateError(failures, 'Homeserver teardown failed');
  }
}

if (import.meta.main) {
  let lease;
  try {
    lease = acquireHomeserverTeardownLease();
    await stop({ keepData: process.argv.includes('--keep-data') });
  } catch (err) {
    console.error('[homeserver] stop failed:', err);
    process.exitCode = 1;
  } finally {
    releaseHomeserverLease(lease);
  }
}
