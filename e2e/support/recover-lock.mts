#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { recoverStaleProcessLock } from './process-lock.mts';
import { homeserverLockFile } from './homeserver/lease.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const resourceFiles: Readonly<Record<string, string>> = {
  'android-avd': join(workspaceRoot, 'dist/.playwright/locks/android-avd.lock'),
  electron: join(workspaceRoot, 'dist/.playwright/locks/electron.lock'),
  homeserver: homeserverLockFile,
};

export function resourceLockFile(resource: string): string {
  const file = resourceFiles[resource];
  if (!file) {
    throw new Error(
      `Unknown E2E resource ${resource}; expected ${Object.keys(resourceFiles).join(', ')}`,
    );
  }
  return file;
}

export function recoverResourceLock(
  resource: string,
  recover: (file: string) => boolean = recoverStaleProcessLock,
): boolean {
  return recover(resourceLockFile(resource));
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
