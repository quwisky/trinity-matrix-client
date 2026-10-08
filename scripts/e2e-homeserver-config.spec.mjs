import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  resolveHomeserverKind,
  resolveHomeserverRuntime,
} from '../e2e/support/homeserver/kind.mts';

const ROOT = join(import.meta.dirname, '..');
const HERE = 'e2e/support/homeserver';
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const TOMLS = [
  `${HERE}/tuwunel/tuwunel.toml`,
  `${HERE}/tuwunel/tuwunel-remote.toml`,
];
/** `key = value` lines, comments stripped, so a commented-out setting never counts. */
const settings = (toml) =>
  toml
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);

describe('E2E homeserver selection', () => {
  it('defaults to tuwunel and accepts only the known kinds', () => {
    expect(HOMESERVER_KINDS).toEqual(['tuwunel', 'synapse']);
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

describe('PR E2E job', () => {
  it('names the homeserver generically, since the default is no longer Synapse', () => {
    const ci = parse(read('.github/workflows/ci.yml'));
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

  it('pins the Tuwunel image by version and digest', () => {
    const compose = parse(read(`${HERE}/tuwunel/docker-compose.yml`));
    const images = Object.values(compose.services)
      .map((service) => service.image)
      .filter(Boolean);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(
        /^ghcr\.io\/matrix-construct\/tuwunel:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
      );
    }
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
  const path = '.github/workflows/e2e-synapse-nightly.yml';
  const workflow = () => parse(read(path));
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
    expect(read('.github/workflows/ci.yml')).not.toContain(
      'TRINITY_E2E_HOMESERVER',
    );
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
    await ensureConfig({ log: () => undefined, sso: false, generate });
    await ensureConfig({ log: () => undefined, sso: false, generate });
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
  });
});
