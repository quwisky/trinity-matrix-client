#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { recoverStaleProcessLock } from './process-lock.mts';
import {
  homeserverLockFile,
  homeserverPortLockFile,
} from './homeserver/lease.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const resourceFiles: Readonly<Record<string, readonly string[]>> = {
  'android-avd': [
    join(workspaceRoot, 'dist/.playwright/locks/android-avd.lock'),
  ],
  electron: [join(workspaceRoot, 'dist/.playwright/locks/electron.lock')],
  homeserver: [homeserverLockFile, homeserverPortLockFile],
};

export function resourceLockFiles(resource: string): readonly string[] {
  const files = resourceFiles[resource];
  if (!files) {
    throw new Error(
      `Unknown E2E resource ${resource}; expected ${Object.keys(resourceFiles).join(', ')}`,
    );
  }
  return files;
}

export interface LockRecovery {
  readonly file: string;
  /** True when a stale lock was removed; an Error when this file could not be recovered. */
  readonly outcome: boolean | Error;
}

/** Each file on its own: a live port lock must not stop recovery of a stale checkout lock. */
export function recoverResourceLock(
  resource: string,
  recover: (file: string) => boolean = recoverStaleProcessLock,
): LockRecovery[] {
  return resourceLockFiles(resource).map((file) => {
    try {
      return { file, outcome: recover(file) };
    } catch (error) {
      return {
        file,
        outcome: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

if (import.meta.main) {
  try {
    const resource = process.argv[2];
    if (!resource) throw new Error('Usage: recover-lock.mts <resource>');
    for (const { file, outcome } of recoverResourceLock(resource)) {
      if (outcome instanceof Error) {
        console.error(
          `[e2e] ${resource}: ${file} not recovered: ${outcome.message}`,
        );
        process.exitCode = 1;
      } else {
        console.info(
          outcome
            ? `[e2e] ${resource}: recovered stale lock ${file}`
            : `[e2e] ${resource}: no stale lock at ${file}`,
        );
      }
    }
  } catch (error) {
    console.error('[e2e] lock recovery failed:', error);
    process.exitCode = 1;
  }
}
