// Opt-in MAS stack (TRINITY_E2E_MAS=1): writes what the services in docker-compose.yml
// beside this file mount. start.mjs drives readiness and seeds the account.
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAS_DATA, STATE_DIR } from '../paths.mjs';
import {
  MAS_HS_TLS,
  MAS_SERVER_NAME,
  MAS_SHARED_SECRET,
} from '../constants.mjs';
import { containerUser } from '../synapse/adapter.mjs';

const exec = promisify(execFile);
const MAS_IMAGE = 'ghcr.io/element-hq/matrix-authentication-service:1.26.0';
const SYNAPSE_IMAGE = 'matrixdotorg/synapse:v1.161.0';
const HS_DIR = join(MAS_DATA, 'homeserver');
const MAS_DIR = join(MAS_DATA, 'mas');
const HS_CONFIG = join(HS_DIR, 'homeserver.yaml');
const GENERATED = join(MAS_DIR, 'generated.yaml');
const MARKER = '# === trinity-e2e-mas ===';

/** Config files whose change must restart a running service (see start.mjs). */
export const masMountedConfig = {
  mas: join(STATE_DIR, 'mas', 'mas.yaml'),
  'homeserver-mas': HS_CONFIG,
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Patch a Synapse-generated homeserver.yaml to delegate authentication to MAS. Idempotent.
 * Delegation refuses to start while Synapse still owns passwords, so they go off here.
 */
export function delegateToMas(yaml) {
  if (yaml.includes(MARKER)) return yaml;
  const base = yaml
    .replace(
      /^trusted_key_servers:[^\n]*(?:\n[ \t]+[^\n]*)*/m,
      'trusted_key_servers: []',
    )
    // `generate` listens on the server name's port minus 400 (8050); compose, Caddy
    // and MAS address this Synapse on 8008.
    .replace(/(^\s+- port:) \d+$/m, '$1 8008')
    .replace(/\s+$/, '');
  return `${base}\n\n${[
    MARKER,
    `public_baseurl: "${MAS_HS_TLS}/"`,
    'password_config:',
    '  enabled: false',
    'matrix_authentication_service:',
    '  enabled: true',
    '  endpoint: "http://mas:8080/"',
    `  secret: "${MAS_SHARED_SECRET}"`,
  ].join('\n')}\n`;
}

/** Generate (once) and patch the delegating Synapse's config, and MAS's secrets. */
export async function prepareMas({ signal, log }) {
  await Promise.all([
    mkdir(HS_DIR, { recursive: true }),
    mkdir(MAS_DIR, { recursive: true }),
  ]);
  if (!(await exists(HS_CONFIG))) {
    log('generating the MAS homeserver.yaml…');
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${HS_DIR}:/data`,
        '-e',
        `SYNAPSE_SERVER_NAME=${MAS_SERVER_NAME}`,
        '-e',
        'SYNAPSE_REPORT_STATS=no',
        ...containerUser,
        SYNAPSE_IMAGE,
        'generate',
      ],
      { signal },
    );
  }
  await writeFile(HS_CONFIG, delegateToMas(await readFile(HS_CONFIG, 'utf8')));
  if (!(await exists(GENERATED))) {
    log('generating MAS secrets and signing keys…');
    const { stdout } = await exec(
      'docker',
      ['run', '--rm', MAS_IMAGE, 'config', 'generate'],
      { signal, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(GENERATED, stdout);
  }
  // MAS runs as a non-root user; a restrictive umask must not hide its config.
  await chmod(GENERATED, 0o644);
}
