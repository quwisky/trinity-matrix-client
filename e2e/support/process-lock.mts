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

/** Acquire a PID lock, taking over only when its recorded process is gone. */
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
      const existingOwner = readFileSync(file, 'utf8').trim();
      const existingPid = Number(existingOwner);
      if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
        throw new Error(
          `${description} is already running as PID ${existingPid}`,
          {
            cause: error,
          },
        );
      }

      // Compare before removal so a newly acquired lock is never mistaken for the
      // stale one we inspected.
      if (readFileSync(file, 'utf8').trim() === existingOwner) {
        rmSync(file, { force: true });
      }
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
