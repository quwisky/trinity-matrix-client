import { stopSynapseSession } from './synapse-session.mts';

/** Tear the Synapse harness down and remove the session file (no-op if Docker
 * was unavailable / never started). */
export default async function globalTeardown(): Promise<void> {
  await stopSynapseSession();
}
