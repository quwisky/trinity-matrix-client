import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  HOMESERVER_KINDS,
  HOMESERVER_RUNTIMES,
  isTuwunel,
  resolveHomeserverKind,
  resolveHomeserverRuntime,
  resolveMasEnabled,
  resolveSsoMock,
} from '../e2e/support/homeserver/kind.mts';
import {
  MAS_HS_TLS,
  MAS_ISSUER,
  MAS_SERVER_NAME,
} from '../e2e/support/homeserver/constants.mjs';
import { workflow as loadWorkflow } from './workspace-sources.mjs';

const ROOT = join(import.meta.dirname, '..');
const HERE = 'e2e/support/homeserver';
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const TOMLS = [
  `${HERE}/tuwunel/tuwunel.toml`,
  `${HERE}/tuwunel/tuwunel-remote.toml`,
  `${HERE}/tuwunel-oauth/tuwunel.toml`,
];
/** `key = value` lines, comments stripped, so a commented-out setting never counts. */
const settings = (toml) =>
  toml
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);

describe('E2E homeserver selection', () => {
  it('defaults to tuwunel and accepts only the known kinds', () => {
    expect(HOMESERVER_KINDS).toEqual(['tuwunel', 'synapse', 'tuwunel-oauth']);
    expect(resolveHomeserverKind({})).toBe('tuwunel');
    expect(resolveHomeserverKind({ TRINITY_E2E_HOMESERVER: '' })).toBe(
      'tuwunel',
    );
    expect(resolveHomeserverKind({ TRINITY_E2E_HOMESERVER: 'synapse' })).toBe(
      'synapse',
    );
    for (const value of ['Tuwunel', 'dendrite', ' synapse']) {
      expect(() =>
        resolveHomeserverKind({ TRINITY_E2E_HOMESERVER: value }),
      ).toThrow(/expected one of: tuwunel, synapse/);
    }
  });
});

describe('Tuwunel workarounds', () => {
  it('apply to both Tuwunel kinds and not to Synapse', () => {
    expect(isTuwunel('tuwunel')).toBe(true);
    expect(isTuwunel('tuwunel-oauth')).toBe(true);
    expect(isTuwunel('synapse')).toBe(false);
    expect(isTuwunel(undefined)).toBe(false);
  });
});

describe('PR E2E job', () => {
  it('names the homeserver generically, since the default is no longer Synapse', () => {
    const ci = loadWorkflow('ci.yml');
    const names = Object.values(ci.jobs).map((job) => job.name);
    expect(names).toContain('E2E (Playwright + homeserver)');
    expect(names).not.toContain('E2E (Playwright + Synapse)');
  });
});

describe('Tuwunel E2E configuration', () => {
  it.each(TOMLS)(
    '%s keeps the harness-only federation and registration settings',
    (path) => {
      const lines = settings(read(path));
      expect(lines).toContain(
        'registration_shared_secret = "trinity-e2e-shared-secret"',
      );
      expect(lines).toContain('trusted_servers = []');
      expect(lines).toContain('allow_invalid_tls_certificates = true');
      expect(lines).toContain('ip_range_denylist = []');
      expect(lines).toContain('default_room_version = "10"');
      // Rewriting the client address from X-Forwarded-For breaks direct :8008 calls.
      expect(lines.some((line) => line.startsWith('ip_source'))).toBe(false);
    },
  );

  it('maps Dex identities by email on the primary', () => {
    const lines = settings(read(TOMLS[0]));
    expect(lines).toContain('[[global.identity_provider]]');
    expect(lines).toContain('userid_claims = ["email"]');
    expect(lines).toContain('issuer_url = "http://localhost:5556/dex"');
  });

  it('disables certificate checks only in the two test configs', () => {
    const hits = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '-l',
        'allow_invalid_tls_certificates',
        '--',
        '.',
        ':!scripts/e2e-homeserver-config.spec.mjs',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter((path) => !path.endsWith('.md'));
    expect(hits.sort()).toEqual([...TOMLS].sort());
  });

  it('pins the Tuwunel image by version and digest, the same in both adapters', () => {
    const images = ['tuwunel', 'tuwunel-oauth'].flatMap((dir) =>
      Object.values(parse(read(`${HERE}/${dir}/docker-compose.yml`)).services)
        .map((service) => service.image)
        .filter(Boolean),
    );
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images).size).toBe(1);
    expect(images[0]).toMatch(
      /^ghcr\.io\/matrix-construct\/tuwunel:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  it('serves QR sign-in through the built-in OAuth server, without SSO, on tuwunel-oauth', () => {
    const lines = settings(read(TOMLS[2]));
    expect(lines).toContain('oidc_native_auth = true');
    expect(lines).toContain('rendezvous_enabled = true');
    expect(lines).toContain('[global.well_known]');
    expect(lines).toContain('client = "https://localhost:8448"');
    expect(lines).not.toContain('[[global.identity_provider]]');
  });

  it('lets Dex redirect to both servers’ SSO callbacks', () => {
    const dex = parse(read(`${HERE}/dex.yaml`));
    expect(dex.staticClients[0].redirectURIs).toEqual([
      'https://localhost:8448/_synapse/client/oidc/callback',
      'https://localhost:8448/_matrix/client/unstable/login/sso/callback/trinity-e2e',
    ]);
  });
});

describe('Nightly Synapse workflow', () => {
  const workflow = () => loadWorkflow('e2e-synapse-nightly.yml');
  const commands = (job) => job.steps.map((step) => step.run ?? '').join('\n');
  /** The suite jobs; `notify` only calls the reusable alert workflow and has no steps. */
  const suites = () =>
    Object.entries(workflow().jobs)
      .filter(([id]) => id !== 'notify')
      .map(([, job]) => job);

  it('runs daily and on demand, outside ci.yml', () => {
    const { on } = workflow();
    expect(on.schedule).toEqual([{ cron: '47 2 * * *' }]);
    expect(on).toHaveProperty('workflow_dispatch');
    // ci.yml picks a server only for QR sign-in on Tuwunel OAuth, never Synapse.
    const ci = loadWorkflow('ci.yml');
    expect(JSON.stringify(ci.env ?? {})).not.toContain(
      'TRINITY_E2E_HOMESERVER',
    );
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (id === 'tuwunel-oauth-e2e') {
        expect(job.env.TRINITY_E2E_HOMESERVER).toBe('tuwunel-oauth');
      } else {
        expect(JSON.stringify(job), id).not.toContain('TRINITY_E2E_HOMESERVER');
      }
    }
  });

  it('runs the browser, Electron full and protocol suites against Synapse', () => {
    expect(workflow().env.TRINITY_E2E_HOMESERVER).toBe('synapse');
    const all = suites().map(commands).join('\n');
    expect(all).toContain('pnpm exec nx run trinity-e2e-browser:e2e');
    expect(all).toContain('xvfb-run -a pnpm nx run trinity-e2e-electron:full');
    expect(all).toContain('pnpm e2e:protocol');
    for (const job of suites()) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(
        job.steps.some(
          (step) =>
            step.uses === './.github/actions/upload-playwright-diagnostics',
        ),
      ).toBe(true);
    }
  });

  it('runs the MAS journeys in their own job', () => {
    const { jobs } = workflow();
    expect(jobs.mas.env.TRINITY_E2E_MAS).toBe('1');
    expect(commands(jobs.mas)).toContain(
      '--timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-browser:e2e -- accounts/mas-session.spec.mts',
    );
    // The Synapse browser shards stay MAS-free: the MAS stack is opt-in and has its own job.
    expect(jobs.browser.env?.TRINITY_E2E_MAS).toBeUndefined();
  });

  it('runs the browser journeys as three shards', () => {
    const { jobs } = workflow();
    const step = jobs.browser.steps.find((entry) => entry.id === 'browser');
    expect(jobs.browser.strategy.matrix.shard).toEqual([1, 2, 3]);
    expect(step.env.TRINITY_E2E_SHARD).toBe('${{ matrix.shard }}/3');
  });
});

describe('E2E homeserver runtime selection', () => {
  it('defaults to docker and accepts native only for Synapse', () => {
    expect(HOMESERVER_RUNTIMES).toEqual(['docker', 'native']);
    expect(resolveHomeserverRuntime({})).toBe('docker');
    expect(
      resolveHomeserverRuntime({
        TRINITY_E2E_HOMESERVER: 'synapse',
        TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
      }),
    ).toBe('native');
    expect(() =>
      resolveHomeserverRuntime({ TRINITY_E2E_HOMESERVER_RUNTIME: 'native' }),
    ).toThrow(/native runs Synapse only/);
    for (const value of ['Native', 'podman', ' docker']) {
      expect(() =>
        resolveHomeserverRuntime({ TRINITY_E2E_HOMESERVER_RUNTIME: value }),
      ).toThrow(/expected one of: docker, native/);
    }
  });
});

describe('Synapse adapter config generation', () => {
  let stateDir;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  async function adapterIn(dir) {
    vi.stubEnv('TRINITY_E2E_STATE_DIR', dir);
    vi.resetModules();
    return import('../e2e/support/homeserver/synapse/adapter.mjs');
  }

  const generateInto = (dir) =>
    vi.fn(async () => {
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(
        join(dir, 'data/homeserver.yaml'),
        'server_name: "localhost"\nregistration_shared_secret: "random"\n',
      );
    });

  it('generates through the injected generator and omits Dex when SSO is unavailable', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    const generate = generateInto(stateDir);
    const ctx = { log: () => undefined, native: true, sso: false, generate };
    await ensureConfig(ctx);
    await ensureConfig(ctx);
    const yaml = readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8');
    expect(generate).toHaveBeenCalledOnce();
    expect(yaml).toContain(
      'registration_shared_secret: "trinity-e2e-shared-secret"',
    );
    expect(yaml).toContain('public_baseurl: "https://localhost:8448/"');
    expect(yaml).toContain('url_preview_enabled: true');
    // Synapse refuses to start with previews enabled and no explicit blocklist.
    const block = yaml.match(
      /url_preview_ip_range_blacklist:\n((?:\s+- .*\n?)+)/,
    );
    expect(block?.[1]).toContain('127.0.0.0/8');
    expect(block?.[1]).toContain('::1/128');
    expect(yaml).not.toContain('trinity-e2e-oidc');
    expect(yaml).not.toContain('oidc_providers');
    // No identity server configured: Synapse keeps verifying TLS.
    expect(yaml).not.toContain('use_insecure_ssl_client');
  });

  it('relaxes TLS for outbound calls only when Sydent is configured', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    await ensureConfig({
      log: () => undefined,
      native: true,
      sso: false,
      identity: true,
      generate: generateInto(stateDir),
    });
    const yaml = parse(
      readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8'),
    );
    expect(yaml.use_insecure_ssl_client_just_for_testing_do_not_use).toBe(true);
  });

  it('adds Dex on loopback for a native runtime with Dex, keeping the native blocklist', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    await ensureConfig({
      log: () => undefined,
      native: true,
      generate: generateInto(stateDir),
    });
    const yaml = readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8');
    expect(yaml).toContain('idp_id: dex');
    // No compose network natively: Synapse reaches Dex on the loopback it shares.
    expect(yaml).toContain('token_endpoint: "http://localhost:5556/dex/token"');
    expect(yaml).not.toContain('dex:5556');
    expect(yaml).toMatch(
      /url_preview_ip_range_blacklist:\n\s+- '127\.0\.0\.0\/8'/,
    );
  });

  it("points Synapse at Dex's mock connector and maps its email to the localpart", async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    await ensureConfig({
      log: () => undefined,
      native: true,
      ssoMock: true,
      generate: generateInto(stateDir),
    });
    const yaml = readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8');
    expect(yaml).toContain(
      'authorization_endpoint: "http://localhost:5556/dex/auth/mock"',
    );
    // The mock's `name` is "Kilgore Trout", not a legal localpart.
    expect(yaml).toContain(
      'localpart_template: "{{ user.email | localpart_from_email }}"',
    );
    expect(yaml).toContain('display_name_template: "{{ user.name }}"');
  });

  it('raises the room-creation and validation-email limits, also on an existing config', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    const ctx = { log: () => undefined, generate: generateInto(stateDir) };
    const config = join(stateDir, 'data/homeserver.yaml');
    const roomCreation =
      /^rc_room_creation:\n {2}per_second: 100\n {2}burst_count: 1000$/m;
    const validation =
      /^rc_3pid_validation:\n {2}per_second: 100\n {2}burst_count: 100$/m;

    await ensureConfig(ctx);
    expect(readFileSync(config, 'utf8')).toMatch(roomCreation);
    expect(readFileSync(config, 'utf8')).toMatch(validation);

    // A stack patched before these limits were added keeps its once-only extras block.
    writeFileSync(
      config,
      readFileSync(config, 'utf8')
        .replace(roomCreation, '')
        .replace(validation, ''),
    );
    await ensureConfig(ctx);
    await ensureConfig(ctx);
    const yaml = readFileSync(config, 'utf8');
    expect(yaml).toMatch(roomCreation);
    expect(yaml.match(/^rc_room_creation:/gm)).toHaveLength(1);
    expect(yaml).toMatch(validation);
    expect(yaml.match(/^rc_3pid_validation:/gm)).toHaveLength(1);
  });

  it('turns off the sync response cache, also on an existing config', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    const ctx = { log: () => undefined, generate: generateInto(stateDir) };
    const config = join(stateDir, 'data/homeserver.yaml');
    const syncCache = /^caches:\n {2}sync_response_cache_duration: 0$/m;

    await ensureConfig(ctx);
    expect(readFileSync(config, 'utf8')).toMatch(syncCache);
    await ensureConfig(ctx);
    expect(readFileSync(config, 'utf8').match(/^caches:/gm)).toHaveLength(1);

    // A config that already has a caches block gets the key inside it, not a second block.
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        syncCache,
        'caches:\n  global_factor: 1.0',
      ),
    );
    await ensureConfig(ctx);
    const yaml = readFileSync(config, 'utf8');
    expect(yaml.match(/^caches:/gm)).toHaveLength(1);
    expect(yaml).toMatch(
      /^caches:\n {2}sync_response_cache_duration: 0\n {2}global_factor: 1\.0$/m,
    );
  });

  it('sends email through Mailpit, by its compose name only on the compose network', async () => {
    const emailBlock = async (ctx) => {
      stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
      const { ensureConfig } = await adapterIn(stateDir);
      await ensureConfig({
        log: () => undefined,
        generate: generateInto(stateDir),
        ...ctx,
      });
      const yaml = parse(
        readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8'),
      );
      rmSync(stateDir, { recursive: true, force: true });
      return yaml.email;
    };
    expect(await emailBlock({})).toEqual({
      smtp_host: 'mailpit',
      smtp_port: 1025,
      notif_from: 'Trinity e2e <noreply@localhost>',
      enable_notifs: false,
    });
    expect((await emailBlock({ native: true })).smtp_host).toBe('localhost');
    expect(
      (await emailBlock({ networkContainer: 'job-container' })).smtp_host,
    ).toBe('localhost');
  });

  it('keeps the Dex block for the Docker runtime', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'trinity-adapter-'));
    const { ensureConfig } = await adapterIn(stateDir);
    await ensureConfig({
      log: () => undefined,
      generate: generateInto(stateDir),
    });
    const yaml = readFileSync(join(stateDir, 'data/homeserver.yaml'), 'utf8');
    expect(yaml).toContain('idp_id: dex');
    expect(yaml).toContain('url_preview_ip_range_blacklist: []');
    expect(yaml).toContain(
      'authorization_endpoint: "http://localhost:5556/dex/auth"',
    );
    expect(yaml).toContain('localpart_template: "{{ user.name }}"');
  });

  it('selects the Dex mock connector only for TRINITY_E2E_SSO_PROVIDER=mock on native', () => {
    const native = {
      TRINITY_E2E_HOMESERVER: 'synapse',
      TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
    };
    expect(resolveSsoMock(native)).toBe(false);
    expect(
      resolveSsoMock({ ...native, TRINITY_E2E_SSO_PROVIDER: 'mock' }),
    ).toBe(true);
    expect(() =>
      resolveSsoMock({ ...native, TRINITY_E2E_SSO_PROVIDER: 'Mock' }),
    ).toThrow(/TRINITY_E2E_SSO_PROVIDER/);
    expect(() => resolveSsoMock({ TRINITY_E2E_SSO_PROVIDER: 'mock' })).toThrow(
      /native runtime/,
    );
  });
});

describe('Opt-in MAS stack', () => {
  const masCompose = () => parse(read(`${HERE}/mas/docker-compose.yml`));
  const masConfig = () => parse(read(`${HERE}/mas/mas.yaml`));

  it('is off unless TRINITY_E2E_MAS=1, and runs only on Docker', () => {
    expect(resolveMasEnabled({})).toBe(false);
    expect(resolveMasEnabled({ TRINITY_E2E_MAS: '0' })).toBe(false);
    expect(resolveMasEnabled({ TRINITY_E2E_MAS: '1' })).toBe(true);
    expect(() => resolveMasEnabled({ TRINITY_E2E_MAS: 'yes' })).toThrow(
      /TRINITY_E2E_MAS/,
    );
    expect(() =>
      resolveMasEnabled({
        TRINITY_E2E_MAS: '1',
        TRINITY_E2E_HOMESERVER: 'synapse',
        TRINITY_E2E_HOMESERVER_RUNTIME: 'native',
      }),
    ).toThrow(/Docker/);
  });

  it('layers its compose file only when enabled', async () => {
    const { composeFiles } =
      await import('../e2e/support/homeserver/paths.mjs');
    expect(composeFiles('tuwunel', '').join(' ')).not.toContain(
      'mas/docker-compose.yml',
    );
    expect(composeFiles('tuwunel', '', { mas: true }).join(' ')).toContain(
      'mas/docker-compose.yml',
    );
  });

  it('pins MAS, PostgreSQL and the Synapse the Synapse adapter runs', async () => {
    const { services } = masCompose();
    // The adapter generates config with these images, so they must be the ones compose runs.
    const { MAS_IMAGE, SYNAPSE_IMAGE } =
      await import('../e2e/support/homeserver/mas/adapter.mjs');
    expect(MAS_IMAGE).toBe(services.mas.image);
    expect(SYNAPSE_IMAGE).toBe(services['homeserver-mas'].image);
    expect(services.mas.image).toBe(
      'ghcr.io/element-hq/matrix-authentication-service:1.26.0',
    );
    expect(services['homeserver-mas'].image).toBe(
      parse(read(`${HERE}/synapse/docker-compose.yml`)).services.homeserver
        .image,
    );
  });

  it("issues 60 s access tokens and accepts the web app's registration", () => {
    const config = masConfig();
    expect(config.experimental.access_token_ttl).toBe(60);
    expect(config.policy.data.client_registration).toEqual({
      allow_insecure_uris: true,
      allow_host_mismatch: true,
    });
    expect(config.http).toEqual({
      public_base: MAS_ISSUER,
      issuer: MAS_ISSUER,
    });
    expect(config.matrix).toMatchObject({
      homeserver: MAS_SERVER_NAME,
      endpoint: 'http://homeserver-mas:8008/',
    });
    // Secrets and signing keys are generated into mas-data at start, never committed.
    expect(config.secrets).toBeUndefined();
  });

  it("raises MAS's per-IP login limit above its default burst of 3", () => {
    // By default MAS allows a burst of 3 password logins per IP, refilled at one per 20 s,
    // and answers the next with "too many requests". Every journey signs in from localhost.
    expect(masConfig().rate_limiting.login.per_ip.burst).toBeGreaterThan(3);
  });

  it('delegates its Synapse to MAS with the shared secret, once', async () => {
    const { delegateToMas } =
      await import('../e2e/support/homeserver/mas/adapter.mjs');
    const generated =
      'server_name: "localhost:8450"\ntrusted_key_servers:\n  - server_name: "matrix.org"\n';
    const once = delegateToMas(generated);
    expect(delegateToMas(once)).toBe(once);
    const yaml = parse(once);
    expect(yaml.matrix_authentication_service).toEqual({
      enabled: true,
      endpoint: 'http://mas:8080/',
      secret: masConfig().matrix.secret,
    });
    expect(yaml.password_config).toEqual({ enabled: false });
    expect(yaml.trusted_key_servers).toEqual([]);
    expect(yaml.public_baseurl).toBe(`${MAS_HS_TLS}/`);
    expect(yaml.experimental_features).toEqual({ msc4108_enabled: true });
    // A config patched by an earlier version is rewritten, not kept.
    const stale = once.replace(
      'msc4108_enabled: true',
      'msc4108_enabled: false',
    );
    expect(delegateToMas(stale)).toBe(once);
  });

  it("leaves MAS's config readable to its non-root container under a umask of 077", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trinity-mas-'));
    const previousUmask = process.umask(0o077);
    try {
      const mode = (path) => statSync(join(dir, path)).mode & 0o777;
      // Existing config files mean prepareMas needs no Docker to generate them.
      mkdirSync(join(dir, 'mas-data/homeserver'), { recursive: true });
      mkdirSync(join(dir, 'mas-data/mas'), { recursive: true });
      writeFileSync(
        join(dir, 'mas-data/homeserver/homeserver.yaml'),
        'server_name: "localhost:8450"\n',
      );
      writeFileSync(join(dir, 'mas-data/mas/generated.yaml'), 'secrets: {}\n');
      vi.stubEnv('TRINITY_E2E_STATE_DIR', dir);
      vi.resetModules();
      const { prepareMas } =
        await import('../e2e/support/homeserver/mas/adapter.mjs');

      await prepareMas({ log: () => undefined });

      expect(mode('mas-data')).toBe(0o755);
      expect(mode('mas-data/mas')).toBe(0o755);
      expect(mode('mas-data/mas/generated.yaml')).toBe(0o644);
    } finally {
      process.umask(previousUmask);
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves its Synapse on 8008, not the port generate derives', async () => {
    const { delegateToMas } =
      await import('../e2e/support/homeserver/mas/adapter.mjs');
    // Synapse's `generate` listens on the server name's port minus 400: 8050 here.
    const generated =
      'server_name: "localhost:8450"\nlisteners:\n  - port: 8050\n    type: http\n';
    expect(parse(delegateToMas(generated)).listeners[0].port).toBe(8008);
  });

  it('fronts the MAS homeserver and MAS on TLS', () => {
    const caddy = read(`${HERE}/Caddyfile`);
    expect(caddy).toContain('https://localhost:8450 {');
    expect(caddy).toContain('reverse_proxy homeserver-mas:8008');
    expect(caddy).toContain('https://localhost:8451 {');
    expect(caddy).toContain('reverse_proxy mas:8080');
  });
});
