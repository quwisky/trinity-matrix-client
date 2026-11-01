import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HomeserverSessionDescriptor } from './session.mts';

/** The seeded account on the opt-in MAS stack (TRINITY_E2E_MAS=1). */
export type MasAccount = NonNullable<HomeserverSessionDescriptor['mas']>;

const exec = promisify(execFile);

/**
 * A fresh account on the MAS stack, for a journey that consumes it. Seeded the way start.mjs
 * seeds the shared one: through MAS's CLI in its container (`container_name` in
 * e2e/support/homeserver/mas/docker-compose.yml).
 */
export async function registerMasUser(
  account: MasAccount,
  user: string,
): Promise<MasAccount> {
  const pass = `${user}-pass`;
  await exec('docker', [
    'exec',
    'trinity-e2e-mas',
    'mas-cli',
    'manage',
    'register-user',
    '--yes',
    '--ignore-password-complexity',
    '--password',
    pass,
    user,
  ]);
  await provisioned();
  return { ...account, user, pass };
}

/**
 * Resolve once MAS has no provisioning or device sync left to run. register-user queues
 * both: the sync deletes every homeserver device MAS has no session for, so one that
 * lands while `mas-cli manage issue-compatibility-token` is between creating its device
 * and committing its session deletes that device, and the token is "not active".
 */
async function provisioned(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await exec('docker', [
      'exec',
      'trinity-e2e-mas-db',
      'psql',
      '-U',
      'mas',
      '-d',
      'mas',
      '-tAc',
      // MAS 1.26's job queue (crates/storage-pg/migrations/*queue_job*.sql). Re-check the
      // queue names and statuses on a MAS upgrade: a renamed one would make this count 0.
      "SELECT count(*) FROM queue_jobs WHERE queue_name IN ('provision-user', 'sync-devices') AND status IN ('available', 'scheduled', 'running')",
    ]);
    if (stdout.trim() === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('MAS did not finish provisioning in 30 s');
}
