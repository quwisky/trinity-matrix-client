import type { MatrixClient } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { serverAdvertises } from './server-support';

function client(
  versions: unknown,
  unstable: Record<string, boolean> = {},
): MatrixClient & { getVersions: ReturnType<typeof vi.fn> } {
  return {
    getVersions: vi.fn(async () => ({
      versions,
      unstable_features: unstable,
    })),
  } as never;
}

describe('serverAdvertises', () => {
  it('accepts a later spec version than the one asked for', async () => {
    const c = client(['v1.11', 'v1.19']);

    await expect(
      firstValueFrom(serverAdvertises(c, { version: 'v1.18' })),
    ).resolves.toBe(true);
  });

  it('compares minor versions numerically, not as text', async () => {
    const c = client(['v1.9']);

    await expect(
      firstValueFrom(serverAdvertises(c, { version: 'v1.18' })),
    ).resolves.toBe(false);
  });

  it('reads an enabled unstable feature flag only', async () => {
    const c = client(['v1.12'], {
      'org.matrix.msc4380.stable': true,
      'org.matrix.msc4380': false,
    });

    await expect(
      firstValueFrom(
        serverAdvertises(c, { unstableFeature: 'org.matrix.msc4380.stable' }),
      ),
    ).resolves.toBe(true);
    await expect(
      firstValueFrom(
        serverAdvertises(c, { unstableFeature: 'org.matrix.msc4380' }),
      ),
    ).resolves.toBe(false);
  });

  it('is true when either the version or the feature is advertised', async () => {
    const c = client(['v1.12'], { 'org.matrix.msc4380.stable': true });

    await expect(
      firstValueFrom(
        serverAdvertises(c, {
          version: 'v1.18',
          unstableFeature: 'org.matrix.msc4380.stable',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('is cold and leaves caching to the SDK', async () => {
    const c = client(['v1.18']);

    const check = serverAdvertises(c, { version: 'v1.18' });
    expect(c.getVersions).not.toHaveBeenCalled();
    await firstValueFrom(check);
    await firstValueFrom(check);

    expect(c.getVersions).toHaveBeenCalledTimes(2);
  });

  it('answers null when the versions request fails, so the caller can ask again', async () => {
    const c = client([]);
    c.getVersions.mockRejectedValueOnce(new TypeError('offline'));

    await expect(
      firstValueFrom(serverAdvertises(c, { version: 'v1.18' })),
    ).resolves.toBeNull();
    await expect(
      firstValueFrom(serverAdvertises(c, { version: 'v1.18' })),
    ).resolves.toBe(false);
  });
});
