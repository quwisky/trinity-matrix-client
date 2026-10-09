// Brings up the disposable e2e homeserver stack and registers the e2e test user.
//
// TRINITY_E2E_HOMESERVER picks the homeserver (`tuwunel`, the default, or `synapse`);
// anything else fails before Docker runs. The selected adapter (tuwunel/ or synapse/)
// owns its compose services and config; this driver owns everything they share:
//   1. Let the adapter write its config (Synapse generates and patches homeserver.yaml;
//      Tuwunel's TOML is committed) and prepare its state directories.
//   2. docker compose up -d (homeserver, remote homeserver, Dex, Caddy), restarting any
//      service whose bind-mounted config changed under a running container.
//   3. Poll /_matrix/client/versions on both servers, Dex's discovery document, the
//      primary's own `m.login.sso` flow, and Caddy's TLS well-known. A timeout prints the
//      failing service's log tail.
//   4. Register the test user through the shared-secret admin API both servers serve.
//   5. Read the server's software and version, and check it is the one selected.
//
// Idempotent-ish: re-running reuses the generated state but re-registers the user
// (ignoring "user already exists"). Tear down with stop.mjs.
import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DATA,
  HERE,
  STATE_DIR,
  composeFiles,
  prepareStateDir,
  resolveNetworkContainer,
} from './paths.mjs';
import {
  DEX_ISSUER,
  HOMESERVER_HTTP,
  HS_TLS,
  MAS_HS_TLS,
  MAS_ISSUER,
  MAS_PASS,
  MAS_SERVER_NAME,
  MAS_USER,
  REGISTRATION_SHARED_SECRET,
  SECONDARY_HTTP,
  SERVER_NAME,
  SSO_EMAIL,
  SSO_PASS,
  SSO_RESET_EMAIL,
  SSO_RESET_USER,
  SSO_USER,
  TEST_PASS,
  TEST_USER,
} from './constants.mjs';
import {
  resolveHomeserverKind,
  resolveHomeserverRuntime,
  resolveMasEnabled,
} from './kind.mts';
import {
  ensureSynapseVenv,
  generateSynapseConfig,
  nativeCaddyfile,
  nativeDexConfig,
  nativeDexVersion,
  nativeLogTail,
  nativePaths,
  nodeProcessApi,
  startNativeServices,
} from './native.mts';
import { acquireHomeserverLease, releaseHomeserverLease } from './lease.mts';
import { masMountedConfig, prepareMas } from './mas/adapter.mjs';
import { synapse } from './synapse/adapter.mjs';
import { tuwunel } from './tuwunel/adapter.mjs';

export * from './constants.mjs';

const exec = promisify(execFile);
const ADAPTERS = { synapse, tuwunel };

/**
 * The config files the stack bind-mounts, by the service that reads one at startup.
 *
 * A bind mount is invisible to compose: rewriting one of these changes nothing about the
 * service *definition*, so `up -d` leaves a running container alone and it goes on
 * serving whatever it loaded when it started. Everything listed here therefore needs an
 * explicit restart once it drifts — for homeserver.yaml that is the entire reason the
 * OIDC region is rewritten per start (see oidcBlock), and dex.yaml is the same class of
 * file the moment its static user list changes under a stack someone left up.
 */
function mountedConfig(adapter) {
  return {
    ...adapter.mountedConfig,
    dex: join(STATE_DIR, 'dex.yaml'),
    caddy: join(STATE_DIR, 'Caddyfile'),
  };
}

/**
 * Fingerprints of the config each service was last actually (re)started with.
 *
 * Not derivable from the files themselves — see above — and deliberately written only
 * after a start we know loaded them, which is also what makes it survive a crash between
 * a rewrite and the restart it needed. Lives under ./data, so stop.mjs discards it with
 * everything else.
 */
const APPLIED_CONFIG = join(DATA, '.applied-config.json');

const log = (m) => console.log(`[homeserver] ${m}`);

/** Resolved once per run by start(); '' means "publish ports", the normal case. */
let networkContainer = '';
let operationSignal;
let kind;
let runtime;
let masEnabled = false;

function secondaryServerName() {
  return networkContainer ? 'localhost:9448' : 'caddy:9448';
}

async function compose(args, opts = {}) {
  return exec(
    'docker',
    [
      'compose',
      ...composeFiles(kind, networkContainer, { mas: masEnabled }),
      ...args,
    ],
    {
      cwd: HERE,
      signal: operationSignal,
      ...opts,
      // The long-running homeserver must own its database and media as *us*, or the
      // next run cannot rewrite its config and stop.mjs cannot remove ./data. The
      // compose files default these when unset.
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
        TRINITY_E2E_REMOTE_SERVER_NAME: secondaryServerName(),
        ...opts.env,
      },
    },
  );
}

/** sha256 of every mounted config file as it now sits on disk, keyed by service. */
async function configFingerprints(files) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([service, file]) => [
      service,
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * Which of those services already have a container up.
 *
 * Asked BEFORE `compose up -d`, the only moment the two cases are still distinguishable:
 * afterwards a container it just created and one it left untouched look identical, and
 * only the second can be serving a stale config.
 */
async function runningServices(services) {
  const up = await Promise.all(
    services.map(async (service) => {
      try {
        const { stdout } = await compose(['ps', '-q', service]);
        return stdout.trim() ? service : '';
      } catch {
        return ''; // no project yet — `up -d` will create it from the current config
      }
    }),
  );
  return up.filter(Boolean);
}

/** What each service was last started with; {} when we have never recorded it. */
async function appliedConfig() {
  try {
    return JSON.parse(await readFile(APPLIED_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

/** The last lines a service logged — the evidence a readiness timeout is missing. */
async function logTail(service) {
  if (runtime === 'native')
    return nativeLogTail(nativePaths(STATE_DIR, DATA), service);
  try {
    const { stdout, stderr } = await compose([
      'logs',
      '--no-color',
      '--tail',
      '80',
      service,
    ]);
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    return `(could not read logs: ${error.message ?? error})`;
  }
}

async function waitFor(
  label,
  service,
  fn,
  { tries = 60, delayMs = 1000 } = {},
) {
  for (let i = 0; i < tries; i++) {
    operationSignal?.throwIfAborted();
    try {
      if (await fn()) {
        log(`${label} ready`);
        return;
      }
    } catch (error) {
      if (operationSignal?.aborted) throw error;
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error(`[homeserver] ${service} logs:\n${await logTail(service)}`);
  throw new Error(`timed out waiting for ${label}`);
}

/** Shared-secret registration (`/_synapse/admin/v1/register`), served by both kinds. */
async function registerUser() {
  log(`registering test user @${TEST_USER}:${SERVER_NAME}…`);
  const url = `${HOMESERVER_HTTP}/_synapse/admin/v1/register`;
  const nonceResponse = await fetch(url, { signal: operationSignal });
  if (!nonceResponse.ok) {
    throw new Error(`registration nonce failed: ${nonceResponse.status}`);
  }
  const { nonce } = await nonceResponse.json();
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${TEST_USER}\0${TEST_PASS}\0notadmin`)
    .digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    signal: operationSignal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username: TEST_USER,
      password: TEST_PASS,
      admin: false,
      mac,
    }),
  });
  if (res.ok) return log('user registered');
  const text = await res.text();
  if (/already.*exists|taken|M_USER_IN_USE/i.test(text)) {
    return log('user already exists — reusing');
  }
  throw new Error(`registering the test user failed: ${res.status} ${text}`);
}

/** Seed the MAS account through MAS's own CLI; MAS provisions it on its homeserver. */
async function registerMasUser() {
  log(`registering MAS user @${MAS_USER}:${MAS_SERVER_NAME}…`);
  try {
    await compose([
      'exec',
      '-T',
      'mas',
      'mas-cli',
      'manage',
      'register-user',
      '--yes',
      '--ignore-password-complexity',
      '--password',
      MAS_PASS,
      MAS_USER,
    ]);
    log('MAS user registered');
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/already exists|taken|in use/i.test(text)) {
      return log('MAS user already exists — reusing');
    }
    throw error;
  }
}

/**
 * The running server's software version, after checking it is the selected kind — a
 * stack of the other kind left running would otherwise pass every readiness poll.
 */
async function serverVersion() {
  const res = await fetch(`${HOMESERVER_HTTP}/_matrix/federation/v1/version`, {
    signal: operationSignal,
  });
  const { server } = await res.json();
  if (server?.name?.toLowerCase() !== kind) {
    throw new Error(
      `TRINITY_E2E_HOMESERVER is ${kind}, but ${HOMESERVER_HTTP} runs ${server?.name ?? 'an unknown server'}`,
    );
  }
  return String(server.version);
}

const clientVersionsReady = async () =>
  (
    await fetch(`${HOMESERVER_HTTP}/_matrix/client/versions`, {
      signal: operationSignal,
    })
  ).ok;

async function wellKnownReady() {
  // Node fetch must accept the self-signed cert; the caller relaxes TLS for this process.
  const res = await fetch(`${HS_TLS}/.well-known/matrix/client`, {
    signal: operationSignal,
  });
  if (!res.ok) return false;
  const body = await res.json();
  return body['m.homeserver']?.base_url === HS_TLS;
}

// Discovery rather than /healthz: it also proves the issuer Dex serves is the one the
// homeserver was configured with, which is the mismatch that would otherwise only
// surface as an opaque token-exchange failure mid-login.
async function dexDiscoveryReady() {
  const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`, {
    signal: operationSignal,
  });
  return res.ok && (await res.json()).issuer === DEX_ISSUER;
}

// The one poll that reads the HOMESERVER's view of the provider rather than Dex's own.
// It only advertises `m.login.sso` when it has loaded an SSO provider, so this is what
// turns "we configured a provider" into "the running server has one".
async function ssoLoginFlowReady() {
  const res = await fetch(`${HOMESERVER_HTTP}/_matrix/client/v3/login`, {
    signal: operationSignal,
  });
  if (!res.ok) return false;
  const { flows = [] } = await res.json();
  return flows.some((flow) => flow.type === 'm.login.sso');
}

/** The SSO identities in dex.yaml, which the homeserver creates on first sign-in. */
const ssoAccounts = () => ({
  // The SSO accounts are not registered here: the homeserver creates each the first
  // time someone completes the Dex round-trip, and they have no Matrix password to
  // register with. Two of them, because the reset spec permanently seeds the one it
  // uses — see SSO_RESET_USER and dex.yaml.
  sso: { user: SSO_USER, email: SSO_EMAIL, pass: SSO_PASS },
  ssoReset: {
    user: SSO_RESET_USER,
    email: SSO_RESET_EMAIL,
    pass: SSO_PASS,
  },
});

/**
 * Native runtime: Synapse from a venv and Caddy as host processes, primary server only.
 * Dex runs too when a `dex` binary is on PATH (`brew install dexidp`), and then SSO is
 * available. The secondary server always is not, nor SSO without Dex, and the session
 * says so (`unavailable`) instead of inventing values.
 */
async function startNative() {
  const paths = nativePaths(STATE_DIR, DATA);
  const dexVersion = await nativeDexVersion(nodeProcessApi, operationSignal);
  const sso = dexVersion !== null;
  log(
    `${kind}, native runtime (host processes, primary server only; ${sso ? `Dex ${dexVersion}` : 'no dex on PATH, so no SSO'})`,
  );
  await prepareStateDir();
  await ensureSynapseVenv(paths, nodeProcessApi, {
    signal: operationSignal,
    log,
  });
  await synapse.preparePrimary({
    signal: operationSignal,
    log,
    native: true,
    sso,
    generate: () =>
      generateSynapseConfig(
        paths,
        SERVER_NAME,
        nodeProcessApi,
        operationSignal,
      ),
  });
  await writeFile(
    paths.caddyfile,
    nativeCaddyfile(
      await readFile(join(STATE_DIR, 'Caddyfile'), 'utf8'),
      paths.caddyAccessLog,
    ),
    'utf8',
  );
  if (sso) {
    await writeFile(
      paths.dexConfig,
      nativeDexConfig(await readFile(join(STATE_DIR, 'dex.yaml'), 'utf8')),
      'utf8',
    );
  }
  startNativeServices(paths, nodeProcessApi, process.env, { dex: sso });
  await waitFor(
    'homeserver client versions',
    'homeserver',
    clientVersionsReady,
  );
  if (sso) {
    await waitFor('dex discovery', 'dex', dexDiscoveryReady);
    await waitFor('homeserver sso login flow', 'homeserver', ssoLoginFlowReady);
  }
  await registerUser();
  await waitFor('caddy well-known (https)', 'caddy', wellKnownReady);
  const version = await serverVersion();
  if (!existsSync(paths.caddyRoot)) {
    throw new Error(
      `Caddy did not create its root certificate at ${paths.caddyRoot}`,
    );
  }
  log(
    `up. ${kind} ${version} (native) homeserver=${HS_TLS} user=@${TEST_USER}:${SERVER_NAME}`,
  );
  return {
    hs: HS_TLS,
    user: TEST_USER,
    pass: TEST_PASS,
    serverName: SERVER_NAME,
    kind,
    version,
    runtime,
    unavailable: sso ? ['remote'] : ['remote', 'sso'],
    caddyRoot: paths.caddyRoot,
    ...(sso ? ssoAccounts() : {}),
  };
}

export async function start({ signal } = {}) {
  operationSignal = signal;
  kind = resolveHomeserverKind();
  runtime = resolveHomeserverRuntime();
  masEnabled = resolveMasEnabled();
  if (runtime === 'native') return startNative();
  const adapter = ADAPTERS[kind];
  networkContainer = await resolveNetworkContainer();
  if (masEnabled && networkContainer) {
    throw new Error(
      'TRINITY_E2E_MAS=1 needs published ports; the shared-namespace topology is not supported',
    );
  }
  log(
    `${kind}, ${
      networkContainer
        ? `sharing the network namespace of container ${networkContainer.slice(0, 12)} (ports not published)`
        : 'publishing ports on the docker host'
    }`,
  );
  await prepareStateDir([
    ...adapter.configFiles,
    ...(masEnabled ? ['mas/mas.yaml'] : []),
  ]);
  await adapter.prepare({
    networkContainer,
    signal: operationSignal,
    log,
    secondaryServerName: secondaryServerName(),
  });
  if (masEnabled) await prepareMas({ signal: operationSignal, log });
  const mounted = {
    ...mountedConfig(adapter),
    ...(masEnabled ? masMountedConfig : {}),
  };
  const fingerprints = await configFingerprints(mounted);
  const wasRunning = await runningServices(Object.keys(mounted));
  log('docker compose up…');
  await compose(['up', '-d']);

  // Make the rewrite above mean something. `up -d` is a no-op for a service whose
  // definition has not changed, and a bind-mounted config file is not part of that
  // definition — so a stack left up by `pnpm e2e:verify:up` would go on serving the
  // previous run's SSO configuration. None of the readiness polls below would notice: they read
  // the homeserver's /versions, Dex's discovery document and Caddy's well-known, and the
  // only one that reads the server's own view of the provider cannot tell one issuer from
  // another.
  // The mismatch would surface much later as an opaque token-exchange failure mid-login,
  // which is the exact failure the rewrite exists to prevent.
  //
  // Restart rather than recreate: the container re-execs its entrypoint and re-reads the
  // mounted file, which is all that is needed, where an unconditional `--force-recreate`
  // would pay the same reboot on every start including the fresh ones. Redundant only in
  // the rare case where `up -d` recreated the service anyway (an image or environment
  // change); one extra reboot there is cheaper than a second query to rule it out.
  //
  // A container that lives in another service's network namespace loses its network when
  // that service restarts, so it restarts too (adapter.restartWith).
  const applied = await appliedConfig();
  const stale = wasRunning.filter(
    (service) => applied[service] !== fingerprints[service],
  );
  for (const service of [...stale]) {
    for (const dependent of adapter.restartWith[service] ?? []) {
      if (!stale.includes(dependent)) stale.push(dependent);
    }
  }
  if (stale.length) {
    log(`config changed under running ${stale.join(', ')} — restarting`);
    await compose(['restart', ...stale]);
  }
  await writeFile(
    APPLIED_CONFIG,
    `${JSON.stringify(fingerprints, null, 2)}\n`,
    'utf8',
  );

  await waitFor(
    'homeserver client versions',
    'homeserver',
    clientVersionsReady,
  );

  await waitFor(
    'secondary homeserver client versions',
    'homeserver-remote',
    async () => {
      const res = await fetch(`${SECONDARY_HTTP}/_matrix/client/versions`, {
        signal: operationSignal,
      });
      return res.ok;
    },
  );

  await waitFor('dex discovery', 'dex', dexDiscoveryReady);
  await waitFor('homeserver sso login flow', 'homeserver', ssoLoginFlowReady);

  await registerUser();

  await waitFor('caddy well-known (https)', 'caddy', wellKnownReady);

  if (masEnabled) {
    await waitFor('mas discovery (https)', 'mas', async () => {
      const res = await fetch(`${MAS_ISSUER}.well-known/openid-configuration`, {
        signal: operationSignal,
      });
      return res.ok && (await res.json()).issuer === MAS_ISSUER;
    });
    // Synapse's view of the provider, through Caddy: delegation is on and routed.
    await waitFor(
      'mas homeserver auth metadata (https)',
      'homeserver-mas',
      async () => {
        const res = await fetch(
          `${MAS_HS_TLS}/_matrix/client/v1/auth_metadata`,
          {
            signal: operationSignal,
          },
        );
        return res.ok && (await res.json()).issuer === MAS_ISSUER;
      },
    );
    await registerMasUser();
  }

  const version = await serverVersion();
  log(
    `up. ${kind} ${version} homeserver=${HS_TLS} secondary=${secondaryServerName()} user=@${TEST_USER}:${SERVER_NAME}`,
  );
  return {
    hs: HS_TLS,
    user: TEST_USER,
    pass: TEST_PASS,
    serverName: SERVER_NAME,
    kind,
    version,
    runtime,
    unavailable: [],
    secondary: {
      hs: SECONDARY_HTTP,
      serverName: secondaryServerName(),
      registrationSecret: REGISTRATION_SHARED_SECRET,
    },
    ...ssoAccounts(),
    ...(masEnabled
      ? {
          mas: {
            hs: MAS_HS_TLS,
            serverName: MAS_SERVER_NAME,
            issuer: MAS_ISSUER,
            user: MAS_USER,
            pass: MAS_PASS,
          },
        }
      : {}),
  };
}

// Allow `node start.mjs` as a standalone bring-up for manual debugging.
if (import.meta.main) {
  // The well-known poll uses Node's fetch, which rejects Caddy's self-signed cert
  // unless we relax TLS verification for this process only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let lease;
  try {
    lease = await acquireHomeserverLease();
    await start();
  } catch (err) {
    console.error('[homeserver] start failed:', err);
    process.exitCode = 1;
  } finally {
    releaseHomeserverLease(lease);
  }
}
