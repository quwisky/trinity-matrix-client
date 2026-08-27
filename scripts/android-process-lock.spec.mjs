import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  releaseProcessLock,
} from '../e2e/support/process-lock.mts';

let directory;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('Android E2E process lock', () => {
  it('preserves an active runner lock when acquisition is rejected', () => {
    directory = mkdtempSync(join(tmpdir(), 'trinity-android-lock-'));
    const file = join(directory, '.lock');
    writeFileSync(file, String(process.pid));

    expect(() => acquireProcessLock(file, 'Android Playwright')).toThrow(
      /already running/,
    );
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    releaseProcessLock(undefined);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
  });

  it('removes only the lock returned to its owner', () => {
    directory = mkdtempSync(join(tmpdir(), 'trinity-android-lock-'));
    const file = join(directory, '.lock');
    const lock = acquireProcessLock(file, 'Android Playwright');
    releaseProcessLock(lock);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('requires manual recovery for a stale lock instead of racing another owner', () => {
    directory = mkdtempSync(join(tmpdir(), 'trinity-android-lock-'));
    const file = join(directory, '.lock');
    writeFileSync(file, '999999999');

    expect(() => acquireProcessLock(file, 'Android Playwright')).toThrow(
      /stale lock.*remove it only after confirming no runner is active/,
    );
    expect(readFileSync(file, 'utf8')).toBe('999999999');
  });
});
