import { describe, expect, it } from 'vitest';
import { optionalReady, unavailableFeatures } from './kind.mts';

describe('homeserver features', () => {
  it('lists the features a session lacks, in declaration order', () => {
    expect(
      unavailableFeatures({
        remote: false,
        sso: true,
        mail: true,
        identity: false,
      }),
    ).toEqual(['remote', 'identity']);
    expect(
      unavailableFeatures({
        remote: true,
        sso: true,
        mail: true,
        identity: true,
      }),
    ).toEqual([]);
  });

  it('makes an optional service unavailable when its wait fails', async () => {
    const logged: string[] = [];
    const log = (message: string): void => void logged.push(message);
    await expect(
      optionalReady(async () => undefined, { name: 'Sydent', log }),
    ).resolves.toBe(true);
    const identity = await optionalReady(
      async () => {
        throw new Error('timed out waiting for sydent (https)');
      },
      { name: 'Sydent', log },
    );
    expect(identity).toBe(false);
    expect(logged).toEqual([
      'Sydent did not become ready, so it is unavailable',
    ]);
    expect(
      unavailableFeatures({ remote: true, sso: true, mail: true, identity }),
    ).toEqual(['identity']);
  });

  it('still fails an aborted start', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      optionalReady(
        async () => {
          throw new Error('aborted');
        },
        { name: 'Sydent', log: () => undefined, signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
  });
});
