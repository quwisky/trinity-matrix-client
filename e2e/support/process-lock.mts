import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface ProcessLock {
  file: string;
  owner: string;
}

interface ProcessLockOwner {
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseOwner(value: string): ProcessLockOwner | undefined {
  const legacyPid = Number(value.trim());
  if (
    /^\d+$/.test(value.trim()) &&
    Number.isInteger(legacyPid) &&
    legacyPid > 0
  ) {
    return { pid: legacyPid, nonce: 'legacy', createdAt: 'unknown' };
  }
  try {
    const parsed = JSON.parse(value) as Partial<ProcessLockOwner>;
    if (
      Number.isInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.nonce === 'string' &&
      parsed.nonce.length > 0 &&
      typeof parsed.createdAt === 'string'
    ) {
      return parsed as ProcessLockOwner;
    }
  } catch {
    // Invalid JSON is an invalid owner and is handled as a stale lock.
  }
  return undefined;
}

/** Acquire a PID lock without ever deleting a lock another contender may own. */
export function acquireProcessLock(
  file: string,
  description: string,
): ProcessLock {
  mkdirSync(dirname(file), { recursive: true });
  const owner = JSON.stringify({
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  } satisfies ProcessLockOwner);

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
      const parsedOwner = parseOwner(existingOwner);
      if (parsedOwner && processIsAlive(parsedOwner.pid)) {
        throw new Error(
          `${description} is already running as PID ${parsedOwner.pid}`,
          {
            cause: error,
          },
        );
      }
      // Recovery stays explicit so acquisition can never erase another contender.
      throw new Error(
        `${description} left a stale lock at ${file}; ` +
          'run explicit stale-lock recovery after confirming no runner is active',
        { cause: error },
      );
    }
  }

  throw new Error(`Could not acquire ${description} lock at ${file}`);
}

/** Recover a dead owner's lock without displacing a live process. */
export function recoverStaleProcessLock(file: string): boolean {
  let observed: string;
  try {
    observed = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const owner = parseOwner(observed);
  if (owner && processIsAlive(owner.pid)) {
    throw new Error(`Refusing to recover a live process lock at ${file}`);
  }
  const quarantine = `${file}.stale-${process.pid}-${randomUUID()}`;
  renameSync(file, quarantine);
  if (readFileSync(quarantine, 'utf8') !== observed) {
    renameSync(quarantine, file);
    throw new Error(`Process lock at ${file} changed during stale recovery`);
  }
  rmSync(quarantine, { force: true });
  return true;
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
