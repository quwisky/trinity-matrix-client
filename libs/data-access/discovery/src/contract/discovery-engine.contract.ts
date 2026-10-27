import { type Observable, firstValueFrom, toArray } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { NOT_SIGNED_IN, assertPlainData } from '@trinity/util/matrix';
import type { DiscoveryEngine } from '../lib/discovery-engine';

export interface DiscoveryContractSetup {
  engine: DiscoveryEngine;
  accountId: string;
  domain: string;
  publicRoom: { roomId: string; name: string; alias: string };
  otherUser: { userId: string; displayName: string };
}

const NOBODY = '@nobody:invalid';

export function defineDiscoveryEngineContract(
  setup: () => Promise<DiscoveryContractSetup>,
): void {
  describe('DiscoveryEngine contract', () => {
    let context: DiscoveryContractSetup;
    // A live Synapse needs time to settle its user directory.
    beforeAll(async () => {
      context = await setup();
    }, 120_000);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    it('discovers a base URL with https and no trailing slash', async () => {
      const result = await once(context.engine.discover(context.domain));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.baseUrl).toMatch(/^https:\/\//);
      expect(result.value.baseUrl.endsWith('/')).toBe(false);
    });

    it('fails to discover a server that does not exist', async () => {
      const result = await once(context.engine.discover('nonexistent.invalid'));

      expect(result.ok).toBe(false);
    });

    it('finds a public room by name, and not among Spaces', async () => {
      const { publicRoom } = context;
      const query = { term: publicRoom.name, limit: 30 };

      const rooms = await once(
        context.engine.searchPublicRooms(context.accountId, query),
      );
      const spaces = await once(
        context.engine.searchPublicRooms(context.accountId, {
          ...query,
          spaces: true,
        }),
      );

      expect(rooms.ok).toBe(true);
      expect(spaces.ok).toBe(true);
      if (!rooms.ok || !spaces.ok) return;
      expect(
        rooms.value.rooms.find((r) => r.roomId === publicRoom.roomId)?.alias,
      ).toBe(publicRoom.alias);
      expect(
        spaces.value.rooms.some((r) => r.roomId === publicRoom.roomId),
      ).toBe(false);
    });

    it('joins a public room by alias', async () => {
      const { publicRoom } = context;

      await expect(
        once(context.engine.joinRoom(context.accountId, publicRoom.alias)),
      ).resolves.toEqual({ ok: true, value: { roomId: publicRoom.roomId } });
    });

    it('fails to join a missing alias with a 404', async () => {
      // The alias must stay on the account's own server, which `domain` may address differently.
      const server = context.publicRoom.alias.split(':').slice(1).join(':');
      const result = await once(
        context.engine.joinRoom(context.accountId, `#missing:${server}`),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostic.httpStatus).toBe(404);
    });

    it('finds another user in the user directory', async () => {
      const { otherUser } = context;

      const result = await once(
        context.engine.searchUserDirectory(
          context.accountId,
          otherUser.displayName,
          30,
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.users.map((u) => u.userId)).toContain(
        otherUser.userId,
      );
    });

    it('fails with NOT_SIGNED_IN for an account with no session', async () => {
      const expected = { ok: false, failure: NOT_SIGNED_IN };

      await expect(
        once(context.engine.searchPublicRooms(NOBODY, { limit: 30 })),
      ).resolves.toEqual(expected);
      await expect(
        once(context.engine.joinRoom(NOBODY, '#a:invalid')),
      ).resolves.toEqual(expected);
      await expect(
        once(context.engine.searchUserDirectory(NOBODY, 'a', 30)),
      ).resolves.toEqual(expected);
    });
  });
}
