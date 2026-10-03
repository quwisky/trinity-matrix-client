import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  HOMESERVER_KINDS,
  resolveHomeserverKind,
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
