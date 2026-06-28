import { rmSync } from 'node:fs';
import { stop } from '../../../../e2e/synapse/stop.mjs';
import { SESSION_FILE } from './global-setup.mts';

/** Tear the Synapse harness down and remove the session file (no-op if Docker
 * was unavailable / never started). */
export default async function globalTeardown(): Promise<void> {
  try {
    await stop();
  } catch {
    /* harness was never up — ignore */
  }
  rmSync(SESSION_FILE, { force: true });
}
