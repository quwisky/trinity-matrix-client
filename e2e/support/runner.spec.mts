import { describe, expect, it, vi } from 'vitest';
import { prepareWebBundle, runPlaywright } from './run-playwright.mts';
import { recoverResourceLock, resourceLockFile } from './recover-lock.mts';
import { synapseLockFile } from './synapse/lease.mts';

describe('E2E runner boundaries', () => {
  it('rejects malformed runner arguments before acquiring resources', async () => {
    await expect(runPlaywright([])).rejects.toThrow(/requires --config/);
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

  it('rejects manifest recording without a build or explicit prebuilt reuse', async () => {
    const execute = vi.fn();

    await expect(
      prepareWebBundle(
        {
          bundleManifest: true,
          reusePrebuilt: false,
          environment: {},
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).rejects.toThrow(/requires --build/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('builds then records the production bundle before publishing reuse', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 0,
      timedOut: false,
    });
    const environment: NodeJS.ProcessEnv = {};

    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment,
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).resolves.toBe(0);

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['exec', 'nx', 'run', 'trinity:build:production'],
      expect.objectContaining({ environment }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ['scripts/web-bundle-manifest.mjs', 'write', 'www'],
      expect.objectContaining({ environment }),
    );
    expect(environment['TRINITY_E2E_PREBUILT_WWW']).toBe('1');
  });

  it('verifies an explicitly prebuilt bundle without rebuilding it', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 0,
      timedOut: false,
    });

    await expect(
      prepareWebBundle(
        {
          bundleManifest: true,
          reusePrebuilt: true,
          environment: {},
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).resolves.toBe(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [
        'scripts/web-bundle-manifest.mjs',
        'verify',
        'dist/web-bundle-manifest.json',
        'www',
      ],
      expect.any(Object),
    );
  });

  it('stops after either bundle preparation command fails', async () => {
    const buildFailure = vi.fn().mockResolvedValue({
      status: 7,
      timedOut: false,
    });
    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment: {},
          signal: new AbortController().signal,
        },
        buildFailure,
      ),
    ).resolves.toBe(7);
    expect(buildFailure).toHaveBeenCalledOnce();

    const manifestFailure = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, timedOut: false })
      .mockResolvedValueOnce({ status: 9, timedOut: false });
    const environment: NodeJS.ProcessEnv = {};
    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment,
          signal: new AbortController().signal,
        },
        manifestFailure,
      ),
    ).resolves.toBe(9);
    expect(manifestFailure).toHaveBeenCalledTimes(2);
    expect(environment['TRINITY_E2E_PREBUILT_WWW']).toBeUndefined();
  });
});
