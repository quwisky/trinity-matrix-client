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

export function recoverResourceLock(
  resource: string,
  recover: (file: string) => boolean = recoverStaleProcessLock,
): boolean {
  // Every file is tried: a crash leaves the homeserver's checkout and port locks behind.
  return resourceLockFiles(resource)
    .map((file) => recover(file))
    .includes(true);
}

if (import.meta.main) {
  try {
    const resource = process.argv[2];
    if (!resource) throw new Error('Usage: recover-lock.mts <resource>');
    const recovered = recoverResourceLock(resource);
    console.info(
      recovered
        ? `[e2e] recovered stale ${resource} lock`
        : `[e2e] ${resource} had no stale lock`,
    );
  } catch (error) {
    console.error('[e2e] lock recovery failed:', error);
    process.exitCode = 1;
  }
}
