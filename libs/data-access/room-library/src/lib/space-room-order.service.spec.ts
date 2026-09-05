import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { firstValueFrom } from 'rxjs';
import { SpaceRoomOrderService } from './space-room-order.service';

const store = new Map<string, string>();
let failStorage = false;
let setCalls = 0;

// The service talks to @capacitor/preferences directly (the repo's preference pattern), so
// stub the plugin with an in-memory map rather than the whole native layer.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (failStorage) {
        throw new Error('storage unavailable');
      }
      return { value: store.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      setCalls += 1;
      if (failStorage) {
        throw new Error('storage unavailable');
      }
      store.set(key, value);
    },
  },
}));

const ME = '@me:hs';
const ALT = '@alt:hs';
const SPACE = '!s:hs';
const defaultKey = (userId: string) => `trinity.spaces.order.default.${userId}`;
const overridesKey = (userId: string) =>
  `trinity.spaces.order.overrides.${userId}`;

function harness(accounts: string[] = [ME], active: string | null = ME) {
  const accountIds = signal<readonly string[]>(accounts);
  const activeUserId = signal<string | null>(active);
  const matrix = {
    accountIds: accountIds.asReadonly(),
    activeUserId: activeUserId.asReadonly(),
  } as unknown as MatrixClientService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SpaceRoomOrderService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return {
    svc: TestBed.inject(SpaceRoomOrderService),
    accountIds: accountIds as WritableSignal<readonly string[]>,
    activeUserId: activeUserId as WritableSignal<string | null>,
  };
}

describe('SpaceRoomOrderService', () => {
  beforeEach(() => {
    store.clear();
    failStorage = false;
    setCalls = 0;
  });

  it('orders by recent activity until something is chosen', async () => {
    const { svc } = harness();
    await firstValueFrom(svc.hydrateKnownAccounts());

    expect(svc.defaultMode()).toBe('recent');
    expect(svc.effectiveFor(SPACE)).toBe('recent');
    expect(svc.overrideFor(SPACE)).toBeNull();
  });

  it('falls back to the default with no account signed in', () => {
    const { svc } = harness([], null);

    expect(svc.defaultMode()).toBe('recent');
    expect(svc.effectiveFor(SPACE)).toBe('recent');
  });

  describe('the account default', () => {
    it('applies to every space that has no override', async () => {
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      svc.setDefault('alphabetical').subscribe();

      expect(svc.defaultMode()).toBe('alphabetical');
      expect(svc.effectiveFor(SPACE)).toBe('alphabetical');
      expect(svc.effectiveFor('!other:hs')).toBe('alphabetical');
    });

    it('survives a relaunch', async () => {
      const first = harness();
      await firstValueFrom(first.svc.hydrateKnownAccounts());
      first.svc.setDefault('space').subscribe();
      expect(store.get(defaultKey(ME))).toBe('space');

      // A fresh service reads nothing until it hydrates — that is what init() is for.
      const { svc } = harness();
      expect(svc.defaultMode()).toBe('recent');
      await firstValueFrom(svc.hydrateKnownAccounts());
      expect(svc.defaultMode()).toBe('space');
    });

    it('is not written when no account is active', async () => {
      const { svc } = harness([], null);
      await firstValueFrom(svc.hydrateKnownAccounts());

      svc.setDefault('space').subscribe();

      expect(store.size).toBe(0);
    });

    it('keeps preference updates cold until subscription', async () => {
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      const command = svc.setDefault('alphabetical');
      expect(svc.defaultMode()).toBe('recent');
      expect(setCalls).toBe(0);

      await firstValueFrom(command);
      expect(svc.defaultMode()).toBe('alphabetical');
      expect(setCalls).toBe(1);
    });

    it('surfaces persistence failures to the subscriber', async () => {
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());
      failStorage = true;

      await expect(
        firstValueFrom(svc.setDefault('alphabetical')),
      ).rejects.toThrow('storage unavailable');
    });
  });

  describe('a per-space override', () => {
    it('beats the account default for that space alone', async () => {
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());
      svc.setDefault('alphabetical').subscribe();

      svc.setForSpace(SPACE, 'space').subscribe();

      expect(svc.effectiveFor(SPACE)).toBe('space');
      expect(svc.overrideFor(SPACE)).toBe('space');
      expect(svc.effectiveFor('!other:hs')).toBe('alphabetical');
      expect(JSON.parse(store.get(overridesKey(ME)) ?? '{}')).toEqual({
        [SPACE]: 'space',
      });
    });

    it('survives a relaunch', async () => {
      const first = harness();
      await firstValueFrom(first.svc.hydrateKnownAccounts());
      first.svc.setForSpace(SPACE, 'space').subscribe();

      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.effectiveFor(SPACE)).toBe('space');
    });

    it('keeps tracking the default once cleared, rather than freezing it', async () => {
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());
      svc.setForSpace(SPACE, 'space').subscribe();

      svc.clearForSpace(SPACE).subscribe();
      expect(svc.overrideFor(SPACE)).toBeNull();
      expect(JSON.parse(store.get(overridesKey(ME)) ?? '{}')).toEqual({});

      // The whole point of deleting the entry instead of storing today's default.
      svc.setDefault('alphabetical').subscribe();
      expect(svc.effectiveFor(SPACE)).toBe('alphabetical');
    });
  });

  describe('per account', () => {
    it('keys each account separately', async () => {
      const { svc } = harness([ME, ALT]);
      await firstValueFrom(svc.hydrateKnownAccounts());

      svc.setDefault('alphabetical').subscribe();
      svc.setForSpace(SPACE, 'space').subscribe();

      expect(store.get(defaultKey(ME))).toBe('alphabetical');
      expect(store.get(defaultKey(ALT))).toBeUndefined();
      expect(store.get(overridesKey(ALT))).toBeUndefined();
    });

    it('re-resolves when the active account changes, with no further call', async () => {
      store.set(defaultKey(ME), 'space');
      store.set(overridesKey(ME), JSON.stringify({ [SPACE]: 'space' }));
      store.set(defaultKey(ALT), 'alphabetical');
      const { svc, activeUserId } = harness([ME, ALT]);
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.defaultMode()).toBe('space');
      expect(svc.overrideFor(SPACE)).toBe('space');

      activeUserId.set(ALT);

      expect(svc.defaultMode()).toBe('alphabetical');
      // @me's override is @me's alone — @alt sees the space follow its own default.
      expect(svc.overrideFor(SPACE)).toBeNull();
      expect(svc.effectiveFor(SPACE)).toBe('alphabetical');
    });

    it('hydrates an account that signs in mid-session', async () => {
      store.set(defaultKey(ALT), 'alphabetical');
      const { svc, accountIds, activeUserId } = harness([ME]);
      await firstValueFrom(svc.hydrateKnownAccounts());
      const lifetime = svc.run().subscribe();

      accountIds.set([ME, ALT]);
      // Root-service effects do not run under TestBed without a tick. The read it kicks off
      // is several microtasks deep (Promise.all over two async gets), so drain the queue
      // rather than awaiting a fixed number of them.
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeUserId.set(ALT);

      expect(svc.defaultMode()).toBe('alphabetical');
      lifetime.unsubscribe();
    });

    it('stops observing later accounts when the runtime session ends', async () => {
      store.set(defaultKey(ALT), 'alphabetical');
      const { svc, accountIds, activeUserId } = harness([ME]);
      await firstValueFrom(svc.hydrateKnownAccounts());
      const lifetime = svc.run().subscribe();
      lifetime.unsubscribe();

      accountIds.set([ME, ALT]);
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeUserId.set(ALT);

      expect(svc.defaultMode()).toBe('recent');
    });
  });

  // A read is async, so a click can land before the stored value arrives. Nothing else in
  // this suite exercises that window — every other test awaits hydration first — and it is
  // exactly where a naive merge silently drops preferences.
  describe('a change made while the stored value is still loading', () => {
    /** Start hydration but do NOT await it, leaving the read in flight. */
    function startLoading() {
      const h = harness();
      const settled = firstValueFrom(h.svc.hydrateKnownAccounts());
      return { ...h, settled };
    }

    it('keeps every other space’s stored override', async () => {
      store.set(
        overridesKey(ME),
        JSON.stringify({ '!a:hs': 'space', '!b:hs': 'alphabetical' }),
      );
      const { svc, settled } = startLoading();

      svc.setForSpace('!c:hs', 'recent').subscribe();
      await settled;

      expect(svc.overrideFor('!a:hs')).toBe('space');
      expect(svc.overrideFor('!b:hs')).toBe('alphabetical');
      expect(svc.overrideFor('!c:hs')).toBe('recent');
      // …and storage matches, so the loss does not simply reappear on the next launch.
      expect(JSON.parse(store.get(overridesKey(ME)) ?? '{}')).toEqual({
        '!a:hs': 'space',
        '!b:hs': 'alphabetical',
        '!c:hs': 'recent',
      });
    });

    it('keeps the stored default when only an override was changed', async () => {
      store.set(defaultKey(ME), 'alphabetical');
      const { svc, settled } = startLoading();

      svc.setForSpace('!c:hs', 'space').subscribe();
      await settled;

      expect(svc.defaultMode()).toBe('alphabetical');
    });

    it('applies a clear, rather than resurrecting the stored override', async () => {
      // Merging two records could not express this: an absent key is indistinguishable from
      // one the merge should restore. Replaying the edit itself is what makes it work.
      store.set(overridesKey(ME), JSON.stringify({ '!a:hs': 'space' }));
      const { svc, settled } = startLoading();

      svc.clearForSpace('!a:hs').subscribe();
      await settled;

      expect(svc.overrideFor('!a:hs')).toBeNull();
      expect(JSON.parse(store.get(overridesKey(ME)) ?? '{}')).toEqual({});
    });

    it('lets the newer choice win over the stored one', async () => {
      store.set(defaultKey(ME), 'space');
      const { svc, settled } = startLoading();

      svc.setDefault('alphabetical').subscribe();
      await settled;

      expect(svc.defaultMode()).toBe('alphabetical');
      expect(store.get(defaultKey(ME))).toBe('alphabetical');
    });
  });

  describe('bad stored data', () => {
    it('falls back when storage throws', async () => {
      failStorage = true;
      const { svc } = harness();

      await expect(firstValueFrom(svc.hydrateKnownAccounts())).resolves.toEqual(
        {
          kind: 'partial',
          accounts: [
            {
              accountId: ME,
              kind: 'defaulted',
              diagnostic: { code: 'room-order-storage-unavailable' },
            },
          ],
        },
      );
      expect(svc.defaultMode()).toBe('recent');
    });

    it('re-reads before writing after preferences were temporarily unavailable', async () => {
      // A failed read is not "nothing stored" — the account's real preferences are unknown,
      // so persisting anything derived from defaults would destroy them. Storage recovers
      // before the write, which is what makes this bite: a service that treated the failed
      // read as "nothing stored" would now successfully persist over the real values.
      store.set(defaultKey(ME), 'alphabetical');
      store.set(overridesKey(ME), JSON.stringify({ '!a:hs': 'space' }));
      failStorage = true;
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());
      failStorage = false;

      await firstValueFrom(svc.setForSpace('!c:hs', 'recent'));

      expect(store.get(defaultKey(ME))).toBe('alphabetical');
      expect(JSON.parse(store.get(overridesKey(ME)) ?? '{}')).toEqual({
        '!a:hs': 'space',
        '!c:hs': 'recent',
      });
      expect(svc.effectiveFor('!c:hs')).toBe('recent');
    });

    it('retries a failed read when the account list changes again', async () => {
      store.set(defaultKey(ME), 'alphabetical');
      failStorage = true;
      const { svc, accountIds } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());
      const lifetime = svc.run().subscribe();
      expect(svc.defaultMode()).toBe('recent'); // the read failed

      failStorage = false;
      accountIds.set([ME, ALT]); // any later sign-in re-runs the hydrate effect
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(svc.defaultMode()).toBe('alphabetical');
      lifetime.unsubscribe();
    });

    it.each([
      ['corrupt JSON', '{'],
      ['an array', '[]'],
      ['a bare string', '"space"'],
    ])('ignores overrides stored as %s', async (_label, raw) => {
      store.set(overridesKey(ME), raw);
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.overrideFor(SPACE)).toBeNull();
    });

    it('drops an override naming a mode we no longer ship', async () => {
      store.set(
        overridesKey(ME),
        JSON.stringify({ [SPACE]: 'a-z', '!keep:hs': 'space' }),
      );
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.overrideFor(SPACE)).toBeNull();
      expect(svc.overrideFor('!keep:hs')).toBe('space');
    });

    it('ignores a default naming a mode we no longer ship', async () => {
      store.set(defaultKey(ME), 'a-z');
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.defaultMode()).toBe('recent');
    });

    it('keeps a corrupt override map from taking the default down with it', async () => {
      store.set(defaultKey(ME), 'alphabetical');
      store.set(overridesKey(ME), '{');
      const { svc } = harness();
      await firstValueFrom(svc.hydrateKnownAccounts());

      expect(svc.defaultMode()).toBe('alphabetical');
    });
  });
});
