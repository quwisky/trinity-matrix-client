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
    resources: ['synapse'],
    endpoints: {
      application: 'http://127.0.0.1:43101',
      storybook: 'http://127.0.0.1:43102',
      report: 'http://127.0.0.1:43103',
    },
    artifactsRoot: join(workspaceRoot, 'dist/.playwright/session-12345678'),
    synapse: {
      available: true,
      hs: 'https://localhost:8448',
      user: 'user',
      pass: 'do-not-print',
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
});
