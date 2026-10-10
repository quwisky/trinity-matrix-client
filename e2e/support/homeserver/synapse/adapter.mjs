// Synapse adapter: generates homeserver.yaml for both servers with Synapse's own
// `generate`, then patches in what the e2e suites need. The compose services are in
// docker-compose.yml beside this file; start.mjs drives readiness and registration.
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA, REMOTE_DATA } from '../paths.mjs';
import {
  DEX_ISSUER,
  HS_TLS,
  REGISTRATION_SHARED_SECRET,
  SERVER_NAME,
} from '../constants.mjs';

const exec = promisify(execFile);
const CONFIG = join(DATA, 'homeserver.yaml');
const REMOTE_CONFIG = join(REMOTE_DATA, 'homeserver.yaml');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
export const containerUser =
  typeof process.getuid === 'function'
    ? ['-e', `UID=${process.getuid()}`, '-e', `GID=${process.getgid()}`]
    : [];

const OIDC_START = '# === trinity-e2e-oidc (regenerated every start) ===';
const OIDC_END = '# === end trinity-e2e-oidc ===';

/**
 * The Dex provider block, plus the SSO redirect whitelist that lets Synapse hand the
 * login token back to the app's origin.
 *
 * Rewritten in full on every start rather than appended once, because two values in it
 * vary with how the stack was brought up — how *Synapse* addresses Dex, and the app
 * origin it is allowed to hand a login token back to — and a config left over from a
 * previous run fails at the token exchange with nothing useful in the logs. The
 * browser-facing `authorization_endpoint` is the published port either way; only the
 * server-to-server endpoints move.
 *
 * Rewriting it is not by itself enough to make Synapse serve it: the file is a bind
 * mount, so a container that is already up keeps the block it started with. start()
 * restarts Synapse whenever the two have diverged.
 */
function oidcBlock(ctx) {
  // No compose network under the netns override or the native runtime, so no `dex` DNS
  // name — but everything shares one loopback there, so Dex's port is reachable as localhost.
  const internal =
    ctx.networkContainer || ctx.native ? 'localhost:5556' : 'dex:5556';
  const appOrigin =
    process.env.TRINITY_E2E_APP_URL ??
    process.env.BASE_URL ??
    'http://127.0.0.1:0';
  // The invocation can serve browser and Android children sequentially. Publishing
  // the native callback unconditionally keeps one owner/session valid for both without
  // restarting Synapse between environment adapters.
  const clientWhitelist = [
    `${appOrigin.replace(/\/$/, '')}/`,
    'eu.qwky.trinity://sso-callback',
  ];
  return [
    OIDC_START,
    // Synapse refuses to redirect a login token anywhere it was not told to.
    'sso:',
    '  client_whitelist:',
    ...clientWhitelist.map((url) => `    - "${url}"`),
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
    // Dex routes /auth/{connector} straight to that connector, so the mock skips the form.
    `    authorization_endpoint: "${DEX_ISSUER}/auth${ctx.ssoMock ? '/mock' : ''}"`,
    // Server-facing: Synapse calls these itself, from inside the network.
    `    token_endpoint: "http://${internal}/dex/token"`,
    `    jwks_uri: "http://${internal}/dex/keys"`,
    `    userinfo_endpoint: "http://${internal}/dex/userinfo"`,
    '    user_mapping_provider:',
    '      config:',
    '        subject_claim: "sub"',
    // Dex puts the static user's `username` in `name`; mapping it straight through
    // gives a deterministic localpart and skips Synapse's pick-a-username page. The
    // mock's `name` is "Kilgore Trout" and it sends no preferred_username (Dex 2.46), so
    // its localpart comes from its email, kilgore@kilgore.trout.
    ctx.ssoMock
      ? '        localpart_template: "{{ user.email | localpart_from_email }}"'
      : '        localpart_template: "{{ user.name }}"',
    '        display_name_template: "{{ user.name }}"',
    OIDC_END,
  ].join('\n');
}

/** One-shot container that scaffolds homeserver.yaml into the mounted ./data volume. */
async function generateWithDocker(ctx) {
  await exec(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${DATA}:/data`,
      '-e',
      `SYNAPSE_SERVER_NAME=${SERVER_NAME}`,
      '-e',
      'SYNAPSE_REPORT_STATS=no',
      ...containerUser,
      'ghcr.io/element-hq/synapse:v1.119.0',
      'generate',
    ],
    { signal: ctx.signal },
  );
}

/** Synapse's sample-config recommendation; Synapse itself ships no default list. */
const NATIVE_URL_PREVIEW_BLACKLIST = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '169.254.0.0/16',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '::1/128',
  'fe80::/10',
  'fc00::/7',
  '2001:db8::/32',
  'ff00::/8',
  'fec0::/10',
];

/**
 * Generate homeserver.yaml on first run, then patch in the e2e settings.
 *
 * `ctx.generate` replaces the Docker scaffold (the native runtime runs Synapse's own
 * --generate-config), and `ctx.native` marks it. `ctx.sso === false` leaves the Dex block
 * out, for a native runtime without a `dex` binary; `ctx.ssoMock` points it at Dex's
 * form-free mock connector (TRINITY_E2E_SSO_PROVIDER=mock).
 */
export async function ensureConfig(ctx) {
  if (!(await exists(CONFIG))) {
    ctx.log('generating homeserver.yaml…');
    await (ctx.generate ?? generateWithDocker)(ctx);
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
      // — safe here because this homeserver is disposable and network-isolated. The
      // native runtime shares the host's network, so it lists Synapse's recommended
      // private and reserved ranges: Synapse has no default blocklist and refuses to start
      // with previews enabled and none given. Its Caddy serves the OG page on loopback
      // (http://127.0.0.1:8080/og), so 127.0.0.1 alone is let back through; the LAN
      // ranges and ::1 stay blocked.
      'url_preview_enabled: true',
      ...(ctx.native
        ? [
            'url_preview_ip_range_blacklist:',
            ...NATIVE_URL_PREVIEW_BLACKLIST.map((range) => `  - '${range}'`),
            'url_preview_ip_range_whitelist:',
            "  - '127.0.0.1'",
          ]
        : ['url_preview_ip_range_blacklist: []']),
      // Permissive CORS isn't a Synapse config knob; matrix endpoints already send
      // Access-Control-Allow-Origin: *. Listed here only as a reminder.
    );
  }

  // Newer Synapse defaults room_list_publication_rules to deny-all, and it fails
  // *silently*: createRoom with visibility "public" still answers 200, but the room is
  // recorded private and never reaches /publicRooms (an explicit PUT to the directory
  // is what admits it, with 403 M_UNKNOWN "Not allowed to publish room"). That is why
  // the two directory specs broke on their assertion rather than on their setup when
  // the image moved v1.119 -> v1.157.2, and why nothing in the harness logs said so.
  //
  // Guarded on its own key rather than folded into the extras block above: that block
  // is written once and skipped forever after, so a stack someone already has running
  // would never pick this up. Here the rewrite trips the fingerprint check below, which
  // restarts Synapse so the new rule is actually loaded.
  if (!yaml.includes('room_list_publication_rules')) {
    additions.push('room_list_publication_rules:', '  - "action": "allow"');
  }
  if (!/^federation_verify_certificates:/m.test(yaml)) {
    // The harness Caddy uses its own disposable CA. Federation is still real — only
    // certificate-chain verification is relaxed inside this isolated test network.
    additions.push('federation_verify_certificates: false');
  }
  if (!/^federation_ip_range_blacklist:/m.test(yaml)) {
    // Both homeservers live on Docker-private addresses in this disposable stack.
    additions.push('federation_ip_range_blacklist: []');
  }
  // These disposable server names cannot be known by a public key notary. A slow
  // matrix.org lookup delays signature verification and can make local alias
  // resolution return 502 before Synapse falls back to fetching the peer's key.
  // Replace the generated notary list, including an older harness's insecure-key
  // override, so federation verifies signatures directly against the local peer.
  const beforeTrustedKeys = yaml;
  yaml = yaml.replace(
    /^trusted_key_servers:[^\n]*(?:\n[ \t]+[^\n]*)*/m,
    'trusted_key_servers: []',
  );
  if (!/^trusted_key_servers:/m.test(yaml)) {
    additions.push('trusted_key_servers: []');
  }
  const trustedKeysChanged = yaml !== beforeTrustedKeys;

  if (additions.length) {
    yaml += `\n\n# === appended by e2e/support/homeserver/start.mjs ===\n${additions.join('\n')}\n`;
  }

  // Unlike the blocks above, the OIDC region is torn out and rewritten every time —
  // see oidcBlock() for why it cannot simply be appended once.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const region = new RegExp(
    `\\n*${escape(OIDC_START)}[\\s\\S]*?${escape(OIDC_END)}\\n*`,
  );
  const oidc = ctx.sso === false ? '' : `\n\n${oidcBlock(ctx)}`;
  const patched = `${yaml.replace(region, '\n').replace(/\s+$/, '')}${oidc}\n`;
  const oidcChanged = patched !== yaml;
  yaml = patched;

  if (additions.length || replacedSecret || oidcChanged || trustedKeysChanged) {
    await writeFile(CONFIG, yaml, 'utf8');
    ctx.log(
      `patched homeserver.yaml (shared secret, public_baseurl, rate limits${ctx.sso === false ? '' : ', dex sso'})`,
    );
  }
}

/** Generate and patch the second Synapse used by cross-server room-link journeys. */
async function ensureSecondaryConfig(ctx) {
  const serverName = ctx.secondaryServerName;
  if (!(await exists(REMOTE_CONFIG))) {
    ctx.log(`generating secondary homeserver.yaml for ${serverName}…`);
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${REMOTE_DATA}:/data`,
        '-e',
        `SYNAPSE_SERVER_NAME=${serverName}`,
        '-e',
        'SYNAPSE_REPORT_STATS=no',
        ...containerUser,
        'ghcr.io/element-hq/synapse:v1.157.2',
        'generate',
      ],
      { signal: ctx.signal },
    );
  }

  let yaml = await readFile(REMOTE_CONFIG, 'utf8');
  yaml = yaml.replace(/^server_name:.*$/m, `server_name: "${serverName}"`);
  yaml = yaml.replace(/^registration_shared_secret:.*$/m, (line) =>
    line.startsWith('#')
      ? line
      : `registration_shared_secret: "${REGISTRATION_SHARED_SECRET}"`,
  );
  if (!/^registration_shared_secret:/m.test(yaml)) {
    yaml += `\nregistration_shared_secret: "${REGISTRATION_SHARED_SECRET}"\n`;
  }

  // The remote listener is deliberately distinct from the primary's even inside the
  // container, because netns CI puts both processes on one loopback.
  yaml = yaml.replace(/(^\s+- port:) \d+$/m, '$1 8009');
  // The secondary verifies the primary's signatures through the same local-only
  // key lookup policy; the generated matrix.org notary must not delay this path.
  yaml = yaml.replace(
    /^trusted_key_servers:[^\n]*(?:\n[ \t]+[^\n]*)*/m,
    'trusted_key_servers: []',
  );
  const additions = [];
  if (!/^trusted_key_servers:/m.test(yaml)) {
    additions.push('trusted_key_servers: []');
  }
  if (!/^enable_registration:/m.test(yaml)) {
    additions.push('enable_registration: true');
  }
  if (!/^enable_registration_without_verification:/m.test(yaml)) {
    additions.push('enable_registration_without_verification: true');
  }
  if (!/^federation_verify_certificates:/m.test(yaml)) {
    additions.push('federation_verify_certificates: false');
  }
  if (!/^federation_ip_range_blacklist:/m.test(yaml)) {
    additions.push('federation_ip_range_blacklist: []');
  }
  if (!/^allow_public_rooms_over_federation:/m.test(yaml)) {
    additions.push('allow_public_rooms_over_federation: true');
  }
  if (!/^room_list_publication_rules:/m.test(yaml)) {
    additions.push('room_list_publication_rules:', '  - "action": "allow"');
  }
  if (additions.length) {
    yaml += `\n# === appended by Trinity federation e2e ===\n${additions.join('\n')}\n`;
  }
  await writeFile(REMOTE_CONFIG, yaml, 'utf8');
}

export const synapse = {
  kind: 'synapse',
  configFiles: [],
  mountedConfig: { homeserver: CONFIG, 'homeserver-remote': REMOTE_CONFIG },
  restartWith: {},
  async prepare(ctx) {
    await ensureConfig(ctx);
    await ensureSecondaryConfig(ctx);
  },
  /** The primary server only: the native runtime has no secondary homeserver. */
  async preparePrimary(ctx) {
    await ensureConfig(ctx);
  },
};
