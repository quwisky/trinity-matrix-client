import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  recoverStaleProcessLock,
  releaseProcessLock,
} from './process-lock.mts';
import {
  E2E_SESSION_VERSION,
  readSession,
  recoverStaleSession,
  sessionSummary,
  validateSession,
  writeSession,
  type E2ESessionDescriptor,
} from './session.mts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function descriptor(workspaceRoot: string): E2ESessionDescriptor {
  return {
    version: E2E_SESSION_VERSION,
    id: 'session-12345678',
    workspaceRoot,
    owner: {
      pid: process.pid,
      nonce: 'nonce-12345678',
      createdAt: new Date().toISOString(),
    },
    resources: ['homeserver'],
    endpoints: {
      application: 'http://127.0.0.1:43101',
      storybook: 'http://127.0.0.1:43102',
      report: 'http://127.0.0.1:43103',
    },
    artifactsRoot: join(workspaceRoot, 'dist/.playwright/session-12345678'),
    homeserver: {
      available: true,
      hs: 'https://localhost:8448',
      user: 'user',
      pass: 'do-not-print',
      kind: 'tuwunel',
      version: '1.9.3',
    },
  };
}

describe('E2E session contract', () => {
  it('round-trips a private descriptor and keeps secrets out of diagnostics', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-e2e-session-'));
    directories.push(workspaceRoot);
    const file = join(workspaceRoot, 'session.json');
    const value = descriptor(workspaceRoot);
    writeSession(file, value);
    expect(readSession(file)).toEqual(value);
    expect(sessionSummary(value)).not.toContain('do-not-print');
    expect(readFileSync(file, 'utf8')).toContain('do-not-print');
  });

  it('requires a known homeserver kind and its version when available', () => {
    const value = descriptor('/workspace');
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...value.homeserver, kind: 'conduit' },
      }),
    ).toThrow(/homeserver kind/);
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...value.homeserver, version: '' },
      }),
    ).toThrow(/version/);
    expect(sessionSummary(value)).toContain('homeserver=tuwunel 1.9.3');
  });

  it('rejects invalid endpoints and dead owners', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-e2e-session-'));
    directories.push(workspaceRoot);
    expect(() =>
      validateSession({
        ...descriptor(workspaceRoot),
        endpoints: {
          ...descriptor(workspaceRoot).endpoints,
          application: 'https://example.test:443',
        },
      }),
    ).toThrow(/structural validation/);

    const file = join(workspaceRoot, 'dead.json');
    writeSession(file, {
      ...descriptor(workspaceRoot),
      owner: { ...descriptor(workspaceRoot).owner, pid: 999_999_999 },
    });
    expect(() => readSession(file)).toThrow(/no live owner/);
  });

  it('recovers only a dead validated session descriptor', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-e2e-session-'));
    directories.push(workspaceRoot);
    const staleFile = join(workspaceRoot, 'stale.json');
    writeSession(staleFile, {
      ...descriptor(workspaceRoot),
      owner: { ...descriptor(workspaceRoot).owner, pid: 999_999_999 },
    });
    expect(recoverStaleSession(staleFile)).toBe(true);
    expect(() => readSession(staleFile)).toThrow(/Could not read/);
    expect(recoverStaleSession(staleFile)).toBe(false);

    const liveFile = join(workspaceRoot, 'live.json');
    writeSession(liveFile, descriptor(workspaceRoot));
    expect(() => recoverStaleSession(liveFile)).toThrow(/live E2E session/);
    expect(readSession(liveFile).owner.pid).toBe(process.pid);
  });

  it('requires explicit recovery and never recovers a live process lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-lock-'));
    directories.push(directory);
    const file = join(directory, 'resource.lock');
    writeFileSync(
      file,
      JSON.stringify({
        pid: 999_999_999,
        nonce: 'dead-owner',
        createdAt: 'old',
      }),
    );
    expect(() => acquireProcessLock(file, 'test resource')).toThrow(
      /stale lock/,
    );
    expect(recoverStaleProcessLock(file)).toBe(true);
    const lock = acquireProcessLock(file, 'test resource');
    expect(() => recoverStaleProcessLock(file)).toThrow(/live process lock/);
    releaseProcessLock(lock);
  });

  it('carries the native runtime, its unavailable features and the Caddy root', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-e2e-session-'));
    directories.push(workspaceRoot);
    const file = join(workspaceRoot, 'session.json');
    const base = descriptor(workspaceRoot);
    const value: E2ESessionDescriptor = {
      ...base,
      homeserver: {
        ...base.homeserver!,
        kind: 'synapse',
        version: '1.161.0',
        runtime: 'native',
        unavailable: ['remote', 'sso'],
        caddyRoot:
          '/state/data/caddy-data/caddy/pki/authorities/local/root.crt',
      },
    };
    writeSession(file, value);
    expect(readSession(file)).toEqual(value);
    expect(sessionSummary(value)).toContain(
      'homeserver=synapse 1.161.0 (native)',
    );
  });

  it('rejects an unknown runtime or feature, and a feature both offered and withheld', () => {
    const value = descriptor('/workspace');
    const homeserver = value.homeserver!;
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...homeserver, runtime: 'podman' },
      }),
    ).toThrow(/unknown homeserver runtime/);
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...homeserver, unavailable: ['dex'] },
      }),
    ).toThrow(/unknown unavailable homeserver feature/);
    expect(() =>
      validateSession({
        ...value,
        homeserver: {
          ...homeserver,
          unavailable: ['sso'],
          sso: { user: 'u', email: 'e', pass: 'p' },
        },
      }),
    ).toThrow(/both offers and withholds sso/);
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...homeserver, caddyRoot: 7 },
      }),
    ).toThrow(/Caddy root/);
  });

  it('carries the MAS account and rejects an incomplete one', () => {
    const value = descriptor('/workspace');
    const mas = {
      hs: 'https://localhost:8450',
      serverName: 'localhost:8450',
      issuer: 'https://localhost:8451/',
      user: 'mas-e2e',
      pass: 'p',
    };
    expect(
      validateSession({ ...value, homeserver: { ...value.homeserver!, mas } })
        .homeserver?.mas,
    ).toEqual(mas);
    expect(() =>
      validateSession({
        ...value,
        homeserver: { ...value.homeserver!, mas: { ...mas, pass: '' } },
      }),
    ).toThrow(/invalid MAS account/);
  });
});
