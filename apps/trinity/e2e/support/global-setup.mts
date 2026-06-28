import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The disposable Synapse + Caddy harness lives in the repo-root e2e/ tree and is
// reused here so there's a single source of truth for the test homeserver.
import { start } from '../../../../e2e/synapse/start.mjs';

export const SESSION_FILE = join(import.meta.dirname, '.synapse-session.json');

/**
 * Bring up the disposable Synapse homeserver and record its credentials for the
 * auth-only specs. Docker may be unavailable (CI without registry access); in that
 * case we record `available: false` and those specs skip themselves rather than fail.
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
    console.warn(
      `[e2e] Synapse unavailable (${message}); authenticated specs will skip.`,
    );
    writeFileSync(SESSION_FILE, JSON.stringify({ available: false }));
  }
}
