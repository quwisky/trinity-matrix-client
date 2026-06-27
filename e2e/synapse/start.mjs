// Brings up the disposable Synapse + Caddy stack and registers the e2e test user.
//
// Steps:
//   1. Generate a fresh homeserver.yaml (Synapse's --generate-config) into ./data,
//      then patch in the bits the SAS e2e needs: a registration shared secret, the
//      public https base URL (Caddy), and permissive CORS so the browser app can
//      hit the API cross-origin.
//   2. docker compose up -d (Synapse + Caddy).
//   3. Poll Synapse /health until ready.
//   4. Register the test user via register_new_matrix_user (shared-secret).
//   5. Poll the Caddy TLS front + well-known until reachable.
//
// Idempotent-ish: re-running reuses the generated config but re-registers the user
// (ignoring "user already exists"). Tear down with stop.mjs.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const CONFIG = join(DATA, 'homeserver.yaml');

export const SYNAPSE_HTTP = 'http://localhost:8008';
export const HS_TLS = 'https://localhost:8448';
export const SERVER_NAME = 'localhost';
export const REGISTRATION_SHARED_SECRET = 'trinity-e2e-shared-secret';

// Test credentials the verify-sas runner logs in with on both contexts.
export const TEST_USER = process.env.TRINITY_USER ?? 'verify-e2e';
export const TEST_PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';

const log = (m) => console.log(`[synapse] ${m}`);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function compose(args, opts = {}) {
  return exec(
    'docker',
    ['compose', '-f', join(HERE, 'docker-compose.yml'), ...args],
    {
      cwd: HERE,
      ...opts,
    },
  );
}

/** Generate homeserver.yaml on first run, then patch in the e2e settings. */
async function ensureConfig() {
  await mkdir(DATA, { recursive: true });
  if (!(await exists(CONFIG))) {
    log('generating homeserver.yaml…');
    // One-shot container to scaffold the config into the mounted ./data volume.
    await exec('docker', [
      'run',
      '--rm',
      '-v',
      `${DATA}:/data`,
      '-e',
      `SYNAPSE_SERVER_NAME=${SERVER_NAME}`,
      '-e',
      'SYNAPSE_REPORT_STATS=no',
      'matrixdotorg/synapse:v1.119.0',
      'generate',
    ]);
  }

  let yaml = await readFile(CONFIG, 'utf8');

  // Patch idempotently: only append blocks we haven't added yet.
  const additions = [];
  // Synapse's `generate` emits a *random* registration_shared_secret into the
  // config (since ~v1.119), so we can't just append ours — register_new_matrix_user
  // would compute its HMAC with our secret while Synapse validates against the
  // random one (403 "HMAC incorrect"). Force our known secret: replace the
  // generated line in place if present, otherwise append it below.
  let replacedSecret = false;
  if (/^registration_shared_secret:.*$/m.test(yaml)) {
    const next = yaml.replace(
      /^registration_shared_secret:.*$/m,
      `registration_shared_secret: "${REGISTRATION_SHARED_SECRET}"`,
    );
    replacedSecret = next !== yaml;
    yaml = next;
  } else {
    additions.push(
      `registration_shared_secret: "${REGISTRATION_SHARED_SECRET}"`,
    );
  }
  if (!yaml.includes('public_baseurl:')) {
    additions.push(`public_baseurl: "${HS_TLS}/"`);
  }
  if (!yaml.includes('# trinity-e2e-extras')) {
    additions.push(
      '# trinity-e2e-extras',
      'enable_registration_without_verification: true',
      'enable_registration: true',
      // Loosen rate limits so two near-simultaneous logins + the SAS to-device
      // traffic don't get throttled mid-flow.
      'rc_login:',
      '  address:',
      '    per_second: 100',
      '    burst_count: 100',
      '  account:',
      '    per_second: 100',
      '    burst_count: 100',
      'rc_message:',
      '  per_second: 100',
      '  burst_count: 100',
      // Permissive CORS isn't a Synapse config knob; matrix endpoints already send
      // Access-Control-Allow-Origin: *. Listed here only as a reminder.
    );
  }

  if (additions.length) {
    yaml += `\n\n# === appended by e2e/synapse/start.mjs ===\n${additions.join('\n')}\n`;
  }
  if (additions.length || replacedSecret) {
    await writeFile(CONFIG, yaml, 'utf8');
    log('patched homeserver.yaml (shared secret, public_baseurl, rate limits)');
  }
}

async function waitFor(label, fn, { tries = 60, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) {
        log(`${label} ready`);
        return;
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function registerUser() {
  log(`registering test user @${TEST_USER}:${SERVER_NAME}…`);
  try {
    // Run register_new_matrix_user inside the Synapse container against its local
    // HTTP listener, using the shared secret.
    await compose([
      'exec',
      '-T',
      'synapse',
      'register_new_matrix_user',
      '-u',
      TEST_USER,
      '-p',
      TEST_PASS,
      '--no-admin',
      '-k',
      REGISTRATION_SHARED_SECRET,
      'http://localhost:8008',
    ]);
    log('user registered');
  } catch (err) {
    const msg = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    if (/already.*exists|User ID already taken/i.test(msg)) {
      log('user already exists — reusing');
    } else {
      throw err;
    }
  }
}

export async function start() {
  await ensureConfig();
  log('docker compose up…');
  await compose(['up', '-d']);

  await waitFor('synapse /health', async () => {
    const res = await fetch(`${SYNAPSE_HTTP}/health`);
    return res.ok;
  });

  await registerUser();

  await waitFor('caddy well-known (https)', async () => {
    const res = await fetch(`${HS_TLS}/.well-known/matrix/client`, {
      // Node fetch must accept the self-signed cert; toggled via env below.
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body['m.homeserver']?.base_url === HS_TLS;
  });

  log(`up. homeserver=${HS_TLS} user=@${TEST_USER}:${SERVER_NAME}`);
  return {
    hs: HS_TLS,
    user: TEST_USER,
    pass: TEST_PASS,
    serverName: SERVER_NAME,
  };
}

// Allow `node start.mjs` as a standalone bring-up for manual debugging.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // The well-known poll uses Node's fetch, which rejects Caddy's self-signed cert
  // unless we relax TLS verification for this process only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  start().catch((err) => {
    console.error('[synapse] start failed:', err);
    process.exit(1);
  });
}
