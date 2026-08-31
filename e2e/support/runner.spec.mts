import { describe, expect, it, vi } from 'vitest';
import { runFeature } from './run-feature.mts';
import { runPlaywright } from './run-playwright.mts';
import { runProtocolCompatibility } from './protocol-runner.mts';
import { recoverResourceLock, resourceLockFile } from './recover-lock.mts';
import { synapseLockFile } from './synapse/lease.mts';

describe('E2E runner boundaries', () => {
  it('rejects malformed runner arguments before acquiring resources', async () => {
    await expect(runPlaywright([])).rejects.toThrow(/requires --config/);
    await expect(runFeature(['--feature=../escape'])).rejects.toThrow(
      /safe-name/,
    );
    await expect(runProtocolCompatibility('unknown')).rejects.toThrow(
      /Unknown protocol compatibility feature/,
    );
  });

  it('maps explicit recovery to the same support-owned Synapse lease', () => {
    expect(resourceLockFile('synapse')).toBe(synapseLockFile);
    const recover = vi.fn(() => true);
    expect(recoverResourceLock('synapse', recover)).toBe(true);
    expect(recover).toHaveBeenCalledWith(synapseLockFile);
    expect(() => resourceLockFile('not-a-resource')).toThrow(
      /Unknown E2E resource/,
    );
  });
});
