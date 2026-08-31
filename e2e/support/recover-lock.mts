#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverStaleProcessLock } from './process-lock.mts';
import { synapseLockFile } from './synapse/lease.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const resourceFiles: Readonly<Record<string, string>> = {
  'android-avd': join(workspaceRoot, 'dist/.playwright/locks/android-avd.lock'),
  'crypto-spike': join(
    workspaceRoot,
    'dist/.playwright/locks/crypto-spike.lock',
  ),
  electron: join(workspaceRoot, 'dist/.playwright/locks/electron.lock'),
  synapse: synapseLockFile,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
