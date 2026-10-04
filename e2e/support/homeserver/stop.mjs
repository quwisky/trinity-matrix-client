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
  STATE_DIR,
  composeFiles,
  resolveNetworkContainer,
} from './paths.mjs';
import {
  HOMESERVER_KINDS,
  resolveHomeserverKind,
  resolveHomeserverRuntime,
} from './kind.mts';
import { nativePaths, nodeProcessApi, stopNativeServices } from './native.mts';
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

/** A bad selection must not strand a running stack: fall back to Docker's teardown. */
function teardownRuntime() {
  try {
    return resolveHomeserverRuntime();
  } catch {
    return 'docker';
  }
}

export async function stop({ keepData = false, signal } = {}) {
  const failures = [];
  let nativeFailed = false;
  // Whatever the selection, native processes named in a PID file are this harness's.
  try {
    await stopNativeServices(
      nativePaths(STATE_DIR, DATA).pidFile,
      nodeProcessApi,
      { signal, log },
    );
  } catch (err) {
    log(`native stop failed: ${err.message ?? err}`);
    failures.push(err);
    nativeFailed = true;
  }
  if (teardownRuntime() === 'docker') {
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
  }
  // ./data holds the PID file: keep it while a native stop failed, so the processes it
  // names stay tracked (and the lease keeps refusing) instead of silently orphaned.
  if (!keepData && !nativeFailed) {
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
