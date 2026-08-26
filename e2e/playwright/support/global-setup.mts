import { startSynapseSession } from './synapse-session.mts';

/**
 * Bring up the disposable Synapse homeserver and record its credentials for the
 * auth-only specs. Docker may be unavailable on a developer's machine; in that case we
 * record `available: false` and those specs skip themselves rather than fail.
 *
 * That fallback is right locally and wrong in CI, where almost every spec is
 * authenticated: a runner that cannot reach Docker would report a **green** E2E job
 * having tested next to nothing. So under `CI` the failure is rethrown instead.
 * `TRINITY_E2E_ALLOW_NO_SYNAPSE=1` opts back out for a CI job that genuinely only wants
 * the unauthenticated specs.
 */
export default async function globalSetup(): Promise<void> {
  const allowUnavailable =
    !process.env['CI'] || Boolean(process.env['TRINITY_E2E_ALLOW_NO_SYNAPSE']);
  await startSynapseSession({ allowUnavailable });
}
