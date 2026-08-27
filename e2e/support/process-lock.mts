import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProcessLock {
  file: string;
  owner: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire a PID lock without ever deleting a lock another contender may own. */
export function acquireProcessLock(
  file: string,
  description: string,
): ProcessLock {
  mkdirSync(dirname(file), { recursive: true });
  const owner = String(process.pid);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, owner, { flag: 'wx' });
      return { file, owner };
    } catch (error) {
      let existingOwner: string;
      try {
        existingOwner = readFileSync(file, 'utf8').trim();
      } catch {
        // The owner can finish between our exclusive-create failure and the read.
        // Retry the atomic create; no lock was removed by this contender.
        continue;
      }
      const existingPid = Number(existingOwner);
      if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
        throw new Error(
          `${description} is already running as PID ${existingPid}`,
          {
            cause: error,
          },
        );
      }
      // Refuse automatic stale-lock reclamation. A read/compare/unlink sequence has
      // a TOCTOU window in which another contender can replace the stale file and
      // have its live lock removed. Manual removal is rare and keeps the fixed-port
      // Synapse stack strictly serialized.
      throw new Error(
        `${description} left a stale lock at ${file} (owner ${existingOwner || '<invalid>'}); ` +
          'remove it only after confirming no runner is active',
        { cause: error },
      );
    }
  }

  throw new Error(`Could not acquire ${description} lock at ${file}`);
}

/** Release only the exact lock acquired by this process. */
export function releaseProcessLock(lock: ProcessLock | undefined): void {
  if (!lock) return;
  try {
    if (readFileSync(lock.file, 'utf8').trim() === lock.owner) {
      rmSync(lock.file, { force: true });
    }
  } catch {
    // Missing/replaced locks are not ours to remove.
  }
}
