// Tears the disposable Synapse + Caddy + Dex stack down and removes generated state.
//
// `docker compose down -v` stops every container and drops the named volumes
// (Caddy CA/data). The generated ./data (homeserver.yaml, signing key, sqlite DB)
// is removed too so the next run starts from a clean slate.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DATA, composeFiles, resolveNetworkContainer } from './paths.mjs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[synapse] ${m}`);

export async function stop({ keepData = false } = {}) {
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
        env: {
          ...process.env,
          TRINITY_E2E_NETWORK_CONTAINER: networkContainer,
        },
      },
    );
  } catch (err) {
    log(`compose down warning: ${err.message ?? err}`);
  }
  if (!keepData) {
    await rm(DATA, { recursive: true, force: true });
    log('removed ./data');
  }
  log('down.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  stop({ keepData: process.argv.includes('--keep-data') }).catch((err) => {
    console.error('[synapse] stop failed:', err);
    process.exit(1);
  });
}
