import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The disposable Synapse + Caddy harness lives in the repo-root e2e/ tree and is
// reused here so there's a single source of truth for the test homeserver.
import { start } from '../../synapse/start.mjs';

export const SESSION_FILE = join(import.meta.dirname, '.synapse-session.json');

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
  // Node's fetch + the browser must accept Caddy's self-signed cert.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  try {
    const { hs, user, pass } = await start();
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ available: true, hs, user, pass }),
    );
    console.log(`[e2e] Synapse ready at ${hs} (user ${user})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env['CI'] && !process.env['TRINITY_E2E_ALLOW_NO_SYNAPSE']) {
      throw new Error(
        `[e2e] Synapse could not start and CI is set, so the authenticated specs ` +
          `would silently skip: ${message}. Docker must be available on the runner ` +
          `(set TRINITY_E2E_ALLOW_NO_SYNAPSE=1 to accept a skipped run).`,
      );
    }
    console.warn(
      `[e2e] Synapse unavailable (${message}); authenticated specs will skip.`,
    );
    writeFileSync(SESSION_FILE, JSON.stringify({ available: false }));
  }
}
