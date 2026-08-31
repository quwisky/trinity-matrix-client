import { join, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import {
  E2E_SESSION_ENV,
  readSession,
  type E2ESessionDescriptor,
} from './session.mts';

export type E2EEndpoint = 'application' | 'report' | 'storybook';

function sessionForConfig(): E2ESessionDescriptor | undefined {
  if (process.env[E2E_SESSION_ENV]) return readSession();
  // Nx's Playwright inference plugin imports config files while building the project
  // graph. It never starts a browser. Give only that plugin worker inert metadata so
  // ordinary Nx commands can discover projects; every executable path still fails
  // closed unless the invocation owner published a validated descriptor.
  if (
    (globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean })
      .NX_PLUGIN_WORKER
  ) {
    return undefined;
  }
  return readSession();
}

/** Read one owner-bound endpoint without embedding a repository-wide fixed port. */
export function e2eEndpoint(endpoint: E2EEndpoint): string {
  return sessionForConfig()?.endpoints[endpoint] ?? 'http://127.0.0.1:1';
}

export function e2eArtifactPath(suiteId: string, leaf: string): string {
  const root =
    sessionForConfig()?.artifactsRoot ??
    resolve('dist/.playwright/nx-config-discovery');
  return join(root, suiteId, leaf);
}

/** Shared reporting and evidence policy; suites still own projects and concurrency. */
export function e2eReportConfig(
  suiteId: string,
): Pick<PlaywrightTestConfig, 'outputDir' | 'reporter'> {
  return {
    outputDir: e2eArtifactPath(suiteId, 'test-output'),
    reporter: process.env['CI']
      ? 'dot'
      : [
          ['list'],
          [
            'html',
            {
              outputFolder: e2eArtifactPath(suiteId, 'report'),
              open: 'never',
            },
          ],
        ],
  };
}
