import { firstValueFrom, toArray } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertPlainData } from '@trinity/util/matrix';
import type { HomeserverEngine } from '../lib/homeserver-engine';

export function defineHomeserverEngineContract(
  setup: () => Promise<{
    engine: HomeserverEngine;
    accountId: string;
    serverName: string;
  }>,
): void {
  describe('HomeserverEngine contract', () => {
    let context: Awaited<ReturnType<typeof setup>>;
    beforeAll(async () => {
      context = await setup();
    });

    it('emits one plain probe of the account homeserver, then completes', async () => {
      const emitted = await firstValueFrom(
        context.engine.probe(context.accountId).pipe(toArray()),
      );

      expect(emitted).toHaveLength(1);
      const probe = emitted[0];
      expect(probe).not.toBeNull();
      expect(probe?.serverName).toBe(context.serverName);
      expect(probe?.baseUrl.endsWith('/')).toBe(false);
      expect(probe?.specVersions?.length).toBeGreaterThan(0);
      expect(() => assertPlainData(probe)).not.toThrow();
    });

    it('emits null for an account with no session', async () => {
      const emitted = await firstValueFrom(
        context.engine.probe('@nobody:invalid').pipe(toArray()),
      );

      expect(emitted).toEqual([null]);
    });
  });
}
