// Tears the disposable Synapse + Caddy stack down and removes generated state.
//
// `docker compose down -v` stops both containers and drops the named volumes
// (Caddy CA/data). The generated ./data (homeserver.yaml, signing key, sqlite DB)
// is removed too so the next run starts from a clean slate.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[synapse] ${m}`);

export async function stop({ keepData = false } = {}) {
  try {
    log('docker compose down…');
    await exec(
      'docker',
      [
        'compose',
        '-f',
        join(HERE, 'docker-compose.yml'),
        'down',
        '-v',
        '--remove-orphans',
      ],
      { cwd: HERE },
    );
  } catch (err) {
    log(`compose down warning: ${err.message ?? err}`);
  }
  if (!keepData) {
    await rm(join(HERE, 'data'), { recursive: true, force: true });
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
