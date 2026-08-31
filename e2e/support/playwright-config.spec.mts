import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  e2eArtifactPath,
  e2eEndpoint,
  e2eReportConfig,
} from './playwright-config.mts';
import {
  E2E_SESSION_ENV,
  E2E_SESSION_VERSION,
  writeSession,
  type E2ESessionDescriptor,
} from './session.mts';

const directories: string[] = [];
const previousSession = process.env[E2E_SESSION_ENV];
const previousPluginWorker = (
  globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean }
).NX_PLUGIN_WORKER;

afterEach(() => {
  if (previousSession === undefined) delete process.env[E2E_SESSION_ENV];
  else process.env[E2E_SESSION_ENV] = previousSession;
  const global = globalThis as typeof globalThis & {
    NX_PLUGIN_WORKER?: boolean;
  };
  if (previousPluginWorker === undefined) delete global.NX_PLUGIN_WORKER;
  else global.NX_PLUGIN_WORKER = previousPluginWorker;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installSession(): E2ESessionDescriptor {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-config-'));
  directories.push(workspaceRoot);
  const descriptor: E2ESessionDescriptor = {
    version: E2E_SESSION_VERSION,
    id: 'config-session',
    workspaceRoot,
    owner: {
      pid: process.pid,
      nonce: 'config-nonce',
      createdAt: new Date().toISOString(),
    },
    resources: [],
    endpoints: {
      application: 'http://127.0.0.1:41001',
      storybook: 'http://127.0.0.1:41002',
      report: 'http://127.0.0.1:41003',
    },
    artifactsRoot: join(workspaceRoot, 'dist/.playwright/config-session'),
  };
  const file = join(workspaceRoot, 'session.json');
  writeSession(file, descriptor);
  process.env[E2E_SESSION_ENV] = file;
  return descriptor;
}

describe('Playwright config primitives', () => {
  it('fails closed when there is no invocation descriptor', () => {
    delete process.env[E2E_SESSION_ENV];
    delete (globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean })
      .NX_PLUGIN_WORKER;
    expect(() => e2eEndpoint('application')).toThrow(E2E_SESSION_ENV);
    expect(() => e2eArtifactPath('browser', 'output')).toThrow(E2E_SESSION_ENV);
  });

  it('exposes inert paths only to Nx project-graph discovery', () => {
    delete process.env[E2E_SESSION_ENV];
    (
      globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean }
    ).NX_PLUGIN_WORKER = true;
    expect(e2eEndpoint('application')).toBe('http://127.0.0.1:1');
    expect(e2eArtifactPath('browser', 'output')).toContain(
      'nx-config-discovery/browser/output',
    );
  });

  it('binds endpoints and reports to the owner-scoped artifact root', () => {
    const descriptor = installSession();
    expect(e2eEndpoint('application')).toBe(descriptor.endpoints.application);
    expect(e2eArtifactPath('browser', 'test-output')).toBe(
      join(descriptor.artifactsRoot, 'browser', 'test-output'),
    );
    expect(e2eReportConfig('browser').outputDir).toBe(
      join(descriptor.artifactsRoot, 'browser', 'test-output'),
    );
  });
});
