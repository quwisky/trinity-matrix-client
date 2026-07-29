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
import {
  DATA,
  composeFiles,
  prepareStateDir,
  resolveNetworkContainer,
} from './paths.mjs';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(DATA, 'homeserver.yaml');

export const SYNAPSE_HTTP = 'http://localhost:8008';
export const HS_TLS = 'https://localhost:8448';
export const SERVER_NAME = 'localhost';
export const REGISTRATION_SHARED_SECRET = 'trinity-e2e-shared-secret';

// Test credentials the verify-sas runner logs in with on both contexts.
export const TEST_USER = process.env.TRINITY_USER ?? 'verify-e2e';
export const TEST_PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';

// The Dex-backed SSO account. It has no Matrix password by construction — Synapse
// creates it through `oidc_providers` — which is exactly what the specs need it for.
// These must match e2e/synapse/dex.yaml.
export const DEX_ISSUER = 'http://localhost:5556/dex';
export const SSO_EMAIL = 'sso-e2e@trinity.test';
export const SSO_PASS = 'sso-e2e-pass-123';
/** Localpart Synapse derives from the Dex identity, via `localpart_template` below. */
export const SSO_USER = 'sso-e2e';

const log = (m) => console.log(`[synapse] ${m}`);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolved once per run by start(); '' means "publish ports", the normal case. */
let networkContainer = '';

async function compose(args, opts = {}) {
  return exec(
    'docker',
    ['compose', ...composeFiles(networkContainer), ...args],
    {
      cwd: HERE,
      ...opts,
      // Same reason as `containerUser` below: the long-running Synapse must own its
      // sqlite DB and media_store as *us*, or the next run cannot rewrite the config
      // and stop.mjs cannot remove ./data. The compose file defaults these to the
      // image's own 991 when unset.
      env: {
        ...process.env,
        ...(typeof process.getuid === 'function'
          ? {
              TRINITY_E2E_UID: String(process.getuid()),
              TRINITY_E2E_GID: String(process.getgid()),
            }
          : {}),
        // The netns override file interpolates this; it may have been detected, not set.
        TRINITY_E2E_NETWORK_CONTAINER: networkContainer,
        ...opts.env,
      },
    },
  );
}

/**
 * The uid/gid to run the Synapse container as, passed through to the image's start.py.
 *
 * Without this the container runs as its built-in 991:991 and chowns the bind-mounted
 * ./data to match — after which *we* cannot rewrite homeserver.yaml (EACCES in
 * ensureConfig) and stop.mjs cannot delete ./data. That never shows up on a filesystem
 * that remaps ownership to the calling user (virtiofs, Docker Desktop's gRPC-FUSE), which
 * is why this went unnoticed locally and would fail every time on a plain Linux CI runner.
 *
 * Empty on Windows, where process.getuid is undefined and bind-mount ownership is moot.
 */
const containerUser =
  typeof process.getuid === 'function'
    ? ['-e', `UID=${process.getuid()}`, '-e', `GID=${process.getgid()}`]
    : [];

const OIDC_START = '# === trinity-e2e-oidc (regenerated every start) ===';
const OIDC_END = '# === end trinity-e2e-oidc ===';

/**
 * The Dex provider block, plus the SSO redirect whitelist that lets Synapse hand the
 * login token back to the app's origin.
 *
 * Rewritten in full on every start rather than appended once, because one value in it —
 * how *Synapse* addresses Dex — depends on how the stack was brought up, and a config
 * left over from the other mode fails at the token exchange with nothing useful in the
 * logs. The browser-facing `authorization_endpoint` is the published port either way;
 * only the server-to-server endpoints move.
 */
function oidcBlock() {
  // No compose network under the netns override, so no `dex` DNS name — but everything
  // shares one loopback there, so the published port is reachable as localhost.
  const internal = networkContainer ? 'localhost:5556' : 'dex:5556';
  const appOrigin = process.env.BASE_URL ?? 'http://localhost:4200';
  return [
    OIDC_START,
    // Synapse refuses to redirect a login token anywhere it was not told to.
    'sso:',
    '  client_whitelist:',
    `    - "${appOrigin.replace(/\/$/, '')}/"`,
    'oidc_providers:',
    '  - idp_id: dex',
    '    idp_name: "Dex"',
    // `discover: false` + explicit endpoints is what lets the browser and Synapse reach
    // the same provider under two different names; a discovery document can only carry
    // one. `skip_verification` then allows the plain-http issuer.
    '    discover: false',
    `    issuer: "${DEX_ISSUER}"`,
    '    skip_verification: true',
    '    client_id: "trinity-e2e"',
    '    client_secret: "trinity-e2e-secret"',
    '    scopes: ["openid", "profile", "email"]',
    // Browser-facing: the user's own navigation, so it must be the published port.
    `    authorization_endpoint: "${DEX_ISSUER}/auth"`,
    // Server-facing: Synapse calls these itself, from inside the network.
    `    token_endpoint: "http://${internal}/dex/token"`,
    `    jwks_uri: "http://${internal}/dex/keys"`,
    `    userinfo_endpoint: "http://${internal}/dex/userinfo"`,
    '    user_mapping_provider:',
    '      config:',
    '        subject_claim: "sub"',
    // Dex puts the static user's `username` in `name`; mapping it straight through
    // gives a deterministic localpart and skips Synapse's pick-a-username page.
    '        localpart_template: "{{ user.name }}"',
    '        display_name_template: "{{ user.name }}"',
    OIDC_END,
  ].join('\n');
}

/** Generate homeserver.yaml on first run, then patch in the e2e settings. */
async function ensureConfig() {
  await prepareStateDir();
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
      ...containerUser,
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
      // Link previews for the URL-preview e2e. The empty IP blacklist lets Synapse
      // fetch the harness OG page (http://caddy:8080/og) on the private docker network
      // — safe here because this homeserver is disposable and network-isolated.
      'url_preview_enabled: true',
      'url_preview_ip_range_blacklist: []',
      // Permissive CORS isn't a Synapse config knob; matrix endpoints already send
      // Access-Control-Allow-Origin: *. Listed here only as a reminder.
    );
  }

  if (additions.length) {
    yaml += `\n\n# === appended by e2e/synapse/start.mjs ===\n${additions.join('\n')}\n`;
  }

  // Unlike the blocks above, the OIDC region is torn out and rewritten every time —
  // see oidcBlock() for why it cannot simply be appended once.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const region = new RegExp(
    `\\n*${escape(OIDC_START)}[\\s\\S]*?${escape(OIDC_END)}\\n*`,
  );
  const patched = `${yaml.replace(region, '\n').replace(/\s+$/, '')}\n\n${oidcBlock()}\n`;
  const oidcChanged = patched !== yaml;
  yaml = patched;

  if (additions.length || replacedSecret || oidcChanged) {
    await writeFile(CONFIG, yaml, 'utf8');
    log(
      'patched homeserver.yaml (shared secret, public_baseurl, rate limits, dex sso)',
    );
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
  networkContainer = await resolveNetworkContainer();
  log(
    networkContainer
      ? `sharing the network namespace of container ${networkContainer.slice(0, 12)} (ports not published)`
      : 'publishing ports on the docker host',
  );
  await ensureConfig();
  log('docker compose up…');
  await compose(['up', '-d']);

  await waitFor('synapse /health', async () => {
    const res = await fetch(`${SYNAPSE_HTTP}/health`);
    return res.ok;
  });

  // Discovery rather than /healthz: it also proves the issuer Dex serves is the one
  // Synapse was configured with, which is the mismatch that would otherwise only
  // surface as an opaque token-exchange failure mid-login.
  await waitFor('dex discovery', async () => {
    const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`);
    return res.ok && (await res.json()).issuer === DEX_ISSUER;
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
    // The SSO account is not registered here: Synapse creates it the first time someone
    // completes the Dex round-trip, and it has no Matrix password to register with.
    sso: { user: SSO_USER, email: SSO_EMAIL, pass: SSO_PASS },
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
