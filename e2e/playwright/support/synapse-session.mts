import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireSynapseLease,
  releaseSynapseLease,
} from '../../synapse/lease.mts';
import type { ProcessLock } from '../../support/process-lock.mts';
import { start } from '../../synapse/start.mjs';
import { stop } from '../../synapse/stop.mjs';

export const SESSION_FILE = join(import.meta.dirname, '.synapse-session.json');
let synapseLock: ProcessLock | undefined;

interface StartOptions {
  allowUnavailable: boolean;
  signal?: AbortSignal;
}

/** Start the shared disposable homeserver and publish its credentials to the specs. */
export async function startSynapseSession({
  allowUnavailable,
  signal,
}: StartOptions): Promise<void> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  synapseLock = await acquireSynapseLease(signal);

  try {
    const { hs, user, pass, sso, ssoReset } = await start({ signal });
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ available: true, hs, user, pass, sso, ssoReset }),
    );
    console.info(`[e2e] Synapse ready at ${hs} (user ${user})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stop().catch(() => undefined);
    releaseSynapseLease(synapseLock);
    synapseLock = undefined;
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
  if (!synapseLock) return;
  try {
    await stop();
  } finally {
    rmSync(SESSION_FILE, { force: true });
    releaseSynapseLease(synapseLock);
    synapseLock = undefined;
  }
}
