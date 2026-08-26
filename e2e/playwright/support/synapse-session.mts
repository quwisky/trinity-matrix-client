import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start } from '../../synapse/start.mjs';
import { stop } from '../../synapse/stop.mjs';

export const SESSION_FILE = join(import.meta.dirname, '.synapse-session.json');

interface StartOptions {
  allowUnavailable: boolean;
}

/** Start the shared disposable homeserver and publish its credentials to the specs. */
export async function startSynapseSession({
  allowUnavailable,
}: StartOptions): Promise<void> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  try {
    const { hs, user, pass, sso, ssoReset } = await start();
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ available: true, hs, user, pass, sso, ssoReset }),
    );
    console.info(`[e2e] Synapse ready at ${hs} (user ${user})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!allowUnavailable) {
      throw new Error(
        `[e2e] Synapse could not start, so the authenticated specs cannot run: ${message}`,
        { cause: error },
      );
    }

    console.warn(
      `[e2e] Synapse unavailable (${message}); authenticated specs will skip.`,
    );
    writeFileSync(SESSION_FILE, JSON.stringify({ available: false }));
  }
}

/** Stop the homeserver owned by this run and discard the session hand-off file. */
export async function stopSynapseSession(): Promise<void> {
  try {
    await stop();
  } finally {
    rmSync(SESSION_FILE, { force: true });
  }
}
