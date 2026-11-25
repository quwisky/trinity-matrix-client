import { ApplicationRef, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { UserEvent, type MatrixClient } from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toPresenceState } from '@trinity/util/matrix';
import { IdentityPresenceService } from './identity-presence.service';
import type { IdentitySdkUser } from '@trinity/data-access/matrix-client';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * The fakes here implement only the slice of MatrixClient the service touches, so the
 * widening cast lives at this one visible seam rather than implicitly at every stub site.
 */
const asClient = (fake: object): MatrixClient =>
  fake as unknown as MatrixClient;

/** The SDK's last raw presence event for a user; its content is what the server sent. */
const presenceEvent = (content: Record<string, unknown>) => ({
  getContent: () => content,
});

/** The signed-in user's id — distinct from the seeded co-members below. */
const SELF = '@self:hs';

/** A fake SDK client: getUser reports seeded presence; on/off track the listener. */
function fakeClient(
  users: Record<string, string> = {},
  statuses: Record<string, string> = {},
) {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getUserId: vi.fn(() => SELF),
    getUser: vi.fn((id: string): IdentitySdkUser | null =>
      id in users
        ? {
            userId: id,
            presence: users[id],
            presenceStatusMsg: statuses[id],
          }
        : null,
    ),
    setPresence: vi.fn(() => Promise.resolve()),
    setSyncPresence: vi.fn(() => Promise.resolve()),
  };
}

/** Device preferences in memory, keyed by storage key and account. */
function memoryStorage() {
  const saved = new Map<string, string>();
  const keyOf = (request: { key: string; context: unknown }) =>
    `${request.key} ${JSON.stringify(request.context)}`;
  const adapter: PreferenceStorageAdapter = {
    read: (request) => {
      const payload = saved.get(keyOf(request));
      return of(
        payload === undefined
          ? { kind: 'missing' as const }
          : { kind: 'found' as const, payload },
      );
    },
    write: (request) => {
      saved.set(keyOf(request), request.payload);
      return of({ kind: 'completed' as const });
    },
  };
  const ownPresenceKey = keyOf({
    key: 'trinity.identity.own-presence',
    context: { kind: 'account', accountId: SELF },
  });
  return {
    adapter,
    ownPresence: () => {
      const payload = saved.get(ownPresenceKey);
      return payload === undefined ? undefined : JSON.parse(payload).value;
    },
    saveOwnPresence: (value: unknown) =>
      saved.set(ownPresenceKey, JSON.stringify({ version: 1, value })),
  };
}

function setup(
  users: Record<string, string> = {},
  statuses: Record<string, string> = {},
) {
  const client = fakeClient(users, statuses);
  const activeUserId = signal<string | null>(SELF);
  const storage = memoryStorage();
  TestBed.configureTestingModule({
    providers: [
      IdentityPresenceService,
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: storage.adapter },
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'instance', asClient(client));
  ngMocks.stubMember(matrix, 'isInitialized', true);
  return {
    svc: TestBed.inject(IdentityPresenceService),
    client,
    matrix,
    activeUserId,
    storage,
  };
}

/** The `User.presence` handler the service registered on the client. */
function presenceHandler(client: ReturnType<typeof fakeClient>) {
  return client.on.mock.calls.find((c) => c[0] === UserEvent.Presence)?.[1] as (
    event: unknown,
    user: { userId: string; presence: string },
  ) => void;
}

describe('IdentityPresenceService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('can register a presence view from a computed member row without writing signals during the read', async () => {
    const { svc } = setup({ '@online:hs': 'online' });
    const lifetime = svc.runProjection().subscribe();
    const row = computed(() => svc.presenceFor('@online:hs')());
    expect(row()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(row()).toBe('online');
    lifetime.unsubscribe();
  });

  it('reports the signed-in user as online even when the server never echoes our own presence', () => {
    // getUser(self) is null/offline here (homeservers typically don't send you your
    // own presence), but we ARE online while our client runs — self must read online.
    const { svc } = setup();
    const state = svc.presenceFor(SELF);
    expect(state()).toBeNull();
    svc.runProjection().subscribe();
    expect(state()).toBe('online');
  });

  it('keeps the signed-in user online even if a self presence event says otherwise', async () => {
    const { svc, client } = setup();
    const state = svc.presenceFor(SELF);
    svc.runProjection().subscribe();
    presenceHandler(client)(undefined, { userId: SELF, presence: 'offline' });
    await Promise.resolve();
    expect(state()).toBe('online');
  });

  it('seeds presence from the client and leaves unknown users unknown', () => {
    const { svc } = setup({ '@online:hs': 'online' });
    const online = svc.presenceFor('@online:hs');
    const stranger = svc.presenceFor('@stranger:hs');
    svc.runProjection().subscribe();
    expect(online()).toBe('online');
    expect(stranger()).toBeNull();
  });

  describe('presenceDetailsFor', () => {
    const NOW = 1_700_000_000_000;
    const seed = (client: ReturnType<typeof fakeClient>, presence: string) =>
      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence,
        presenceStatusMsg: 'On holiday',
        lastActiveAgo: 7_200_000,
        lastPresenceTs: NOW,
        currentlyActive: false,
        events: {
          presence: presenceEvent({ presence, status_msg: 'On holiday' }),
        },
      });

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('presenceDetailsFor exposes state, status message and last active time', () => {
      const { svc, client } = setup();
      seed(client, 'unavailable');
      const details = svc.presenceDetailsFor('@a:hs');
      svc.runProjection().subscribe();
      expect(details()).toEqual({
        state: toPresenceState('unavailable'),
        statusMessage: 'On holiday',
        lastActiveAt: NOW - 7_200_000,
        currentlyActive: false,
      });
    });

    it("lastActiveAt stays fixed when another user's presence event rebuilds the projection", async () => {
      const { svc, client } = setup();
      seed(client, 'unavailable');
      const details = svc.presenceDetailsFor('@a:hs');
      svc.runProjection().subscribe();
      const before = details();

      vi.spyOn(Date, 'now').mockReturnValue(NOW + 3 * 3_600_000);
      presenceHandler(client)(undefined, {
        userId: '@b:hs',
        presence: 'online',
      });
      await Promise.resolve();

      expect(details()?.lastActiveAt).toBe(NOW - 7_200_000);
      expect(details()).toBe(before);
    });

    it('peeks a roster member without caching them, and bumps a revision on each change', async () => {
      const { svc, client } = setup();
      seed(client, 'online');
      svc.runProjection().subscribe();
      const before = svc.revision();
      const seen = computed(() => {
        svc.revision();
        return svc.peekDetails('@a:hs')?.state ?? null;
      });
      expect(seen()).toBe(toPresenceState('online'));

      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence: 'offline',
        presenceStatusMsg: '',
        lastActiveAgo: 0,
        lastPresenceTs: NOW,
        currentlyActive: false,
      });
      presenceHandler(client)(undefined, {
        userId: '@a:hs',
        presence: 'offline',
      });
      await Promise.resolve();

      expect(svc.revision()).toBeGreaterThan(before);
      expect(seen()).toBe(toPresenceState('offline'));
      // Nothing is left behind for the peeked user.
      expect(
        (svc as unknown as { details: Map<string, unknown> }).details.has(
          '@a:hs',
        ),
      ).toBe(false);
    });

    // The SDK only overwrites presenceStatusMsg when an event carries a message.
    it('reads a message the member cleared as cleared', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence: 'online',
        presenceStatusMsg: 'On holiday',
        lastPresenceTs: NOW,
        events: { presence: presenceEvent({ presence: 'online' }) },
      });
      svc.runProjection().subscribe();

      expect(svc.peekDetails('@a:hs')?.statusMessage).toBe('');
    });

    it('peeks null for a user the server never reported (SDK default offline)', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence: 'offline',
        lastActiveAgo: 0,
        lastPresenceTs: 0,
      });
      svc.runProjection().subscribe();
      expect(svc.peekDetails('@a:hs')).toBeNull();
    });

    it('is null for a user with no presence event (SDK default offline)', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence: 'offline',
        lastActiveAgo: 0,
        lastPresenceTs: 0,
      });
      const details = svc.presenceDetailsFor('@a:hs');
      svc.runProjection().subscribe();
      expect(details()).toBeNull();
    });

    it('lastActiveAt is null when lastActiveAgo is missing', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: '@a:hs',
        presence: 'online',
        lastPresenceTs: NOW,
      });
      const details = svc.presenceDetailsFor('@a:hs');
      svc.runProjection().subscribe();
      expect(details()).toMatchObject({ state: 'online', lastActiveAt: null });
    });

    it('keeps the signed-in user online without a presence event', () => {
      const { svc } = setup();
      const details = svc.presenceDetailsFor(SELF);
      svc.runProjection().subscribe();
      expect(details()).toMatchObject({ state: 'online', lastActiveAt: null });
    });

    it('presenceDetailsFor is null for a user the client does not know', () => {
      const { svc } = setup();
      const details = svc.presenceDetailsFor('@ghost:hs');
      svc.runProjection().subscribe();
      expect(details()).toBeNull();
    });

    it('presenceDetailsFor is null while presence is unavailable', () => {
      const { svc, client } = setup();
      seed(client, 'online');
      expect(svc.presenceDetailsFor('@a:hs')()).toBeNull();
    });

    it('presenceDetailsFor updates on a presence event', async () => {
      const { svc, client } = setup();
      const details = svc.presenceDetailsFor('@a:hs');
      svc.runProjection().subscribe();
      expect(details()).toBeNull();
      seed(client, 'online');
      presenceHandler(client)(undefined, {
        userId: '@a:hs',
        presence: 'online',
      });
      await Promise.resolve();
      expect(details()?.state).toBe('online');
    });

    it('presenceDetailsFor resets to null on account switch', () => {
      const { svc, client } = setup();
      seed(client, 'online');
      const details = svc.presenceDetailsFor('@a:hs');
      const lifetime = svc.runProjection().subscribe();
      expect(details()).not.toBeNull();
      lifetime.unsubscribe();
      expect(details()).toBeNull();
    });
  });

  it('memoizes the signal per user id', () => {
    const { svc } = setup();
    expect(svc.presenceFor('@a:hs')).toBe(svc.presenceFor('@a:hs'));
  });

  it('updates a tracked user’s signal when a presence event arrives', async () => {
    const { svc, client } = setup();
    const state = svc.presenceFor('@a:hs'); // track it (starts offline)
    expect(state()).toBeNull();

    svc.runProjection().subscribe();
    client.getUser.mockReturnValue({
      userId: '@a:hs',
      presence: 'online',
      presenceStatusMsg: '',
    });
    presenceHandler(client)(undefined, { userId: '@a:hs', presence: 'online' });
    await Promise.resolve();
    expect(state()).toBe('online');

    client.getUser.mockReturnValue({
      userId: '@a:hs',
      presence: 'unavailable',
      presenceStatusMsg: '',
    });
    presenceHandler(client)(undefined, {
      userId: '@a:hs',
      presence: 'unavailable',
    });
    await Promise.resolve();
    expect(state()).toBe('unavailable');
  });

  it('ignores presence for users nobody is watching', () => {
    const { svc, client } = setup();
    svc.runProjection().subscribe();
    // No throw, and no signal is created for an untracked user.
    expect(() =>
      presenceHandler(client)(undefined, {
        userId: '@nobody:hs',
        presence: 'online',
      }),
    ).not.toThrow();
  });

  it('one owned lifetime wires exactly one presence listener', () => {
    const { svc, client } = setup();
    const lifetime = svc.runProjection().subscribe();
    expect(
      client.on.mock.calls.filter((c) => c[0] === UserEvent.Presence),
    ).toHaveLength(1);
    lifetime.unsubscribe();
  });

  it('teardown detaches the listener', () => {
    const { svc, client } = setup();
    const lifetime = svc.runProjection().subscribe();
    lifetime.unsubscribe();
    expect(client.off).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    );
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const { svc, client, matrix, activeUserId } = setup({ '@a:hs': 'online' });
    activeUserId.set('@a:hs');
    svc.runProjection().subscribe(); // wired to the first client
    TestBed.inject(ApplicationRef).tick(); // effect's first run: same client → no-op
    client.off.mockClear();

    // Switch accounts: the active client becomes a new one; the effect re-wires.
    const client2 = fakeClient({ '@a:hs': 'offline' });
    ngMocks.stubMember(matrix, 'instance', asClient(client2));
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    expect(client.off).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    ); // detached from the old account's client
    expect(client2.on).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    ); // attached to the new one
  });

  it('re-binds onto a fresh client after a re-login and re-seeds tracked users', () => {
    const { svc, client, matrix } = setup({ '@a:hs': 'online' });
    const state = svc.presenceFor('@a:hs');
    svc.runProjection().subscribe();
    expect(state()).toBe('online');

    // A re-login hands the service a new client where @a is now offline.
    const client2 = fakeClient({ '@a:hs': 'offline' });
    ngMocks.stubMember(matrix, 'instance', asClient(client2));
    svc.runProjection().subscribe();

    expect(client.off).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    );
    expect(state()).toBe('offline'); // re-seeded from the new client
  });

  describe('own presence', () => {
    it('reports the status the signed-in user chose, everywhere self is read', async () => {
      const { svc } = setup();
      const state = svc.presenceFor(SELF);
      const details = svc.presenceDetailsFor(SELF);
      svc.runProjection().subscribe();
      expect(state()).toBe('online');

      await firstValueFrom(svc.setOwnPresence('unavailable', 'lunch'));

      expect(state()).toBe('unavailable');
      expect(details()).toEqual(
        expect.objectContaining({
          state: 'unavailable',
          statusMessage: 'lunch',
        }),
      );
      expect(svc.peekDetails(SELF)?.state).toBe('unavailable');
    });

    it('restores the status the server reports for the signed-in user on connect', () => {
      const { svc, client } = setup();
      client.getUser.mockImplementation((id: string) =>
        id === SELF
          ? {
              userId: SELF,
              presence: 'unavailable',
              presenceStatusMsg: 'away for the day',
              lastPresenceTs: 1_000,
              events: {
                presence: presenceEvent({
                  presence: 'unavailable',
                  status_msg: 'away for the day',
                }),
              },
            }
          : null,
      );
      const state = svc.presenceFor(SELF);
      svc.runProjection().subscribe();

      expect(state()).toBe('unavailable');
      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('away for the day');
    });

    it('ignores the SDK placeholder offline the server never reported', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'offline',
        lastPresenceTs: 0,
      });
      svc.runProjection().subscribe();
      svc.loadOwnPresence();

      expect(svc.myPresence()).toBe('online');
      expect(svc.presenceFor(SELF)()).toBe('online');
    });

    // The SDK only overwrites presenceStatusMsg when an event carries one, so a cleared
    // message lingers there.
    it('keeps a status message the user cleared when their presence echo arrives', async () => {
      const { svc, client } = setup();
      svc.runProjection().subscribe();
      await firstValueFrom(svc.setOwnPresence('online', ''));
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'online',
        presenceStatusMsg: 'lunch',
        lastPresenceTs: Date.now() + 1_000,
        events: { presence: presenceEvent({ presence: 'online' }) },
      });

      presenceHandler(client)(undefined, { userId: SELF, presence: 'online' });
      await Promise.resolve();

      expect(svc.myStatusMessage()).toBe('');
    });

    it('adopts a newer message set on another device', async () => {
      const { svc, client } = setup();
      svc.runProjection().subscribe();
      await firstValueFrom(svc.setOwnPresence('online', 'lunch'));
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'online',
        presenceStatusMsg: 'in a meeting',
        lastPresenceTs: Date.now() + 1_000,
        events: {
          presence: presenceEvent({
            presence: 'online',
            status_msg: 'in a meeting',
          }),
        },
      });

      presenceHandler(client)(undefined, { userId: SELF, presence: 'online' });
      await Promise.resolve();

      expect(svc.myStatusMessage()).toBe('in a meeting');
    });

    it('reads a message cleared elsewhere as cleared on the first report', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'online',
        presenceStatusMsg: 'stale',
        lastPresenceTs: 1_000,
        events: { presence: presenceEvent({ presence: 'online' }) },
      });
      svc.runProjection().subscribe();

      expect(svc.myStatusMessage()).toBe('');
    });

    it('keeps a status the user just set over an older server report', async () => {
      const { svc, client } = setup();
      const state = svc.presenceFor(SELF);
      svc.runProjection().subscribe();
      await firstValueFrom(svc.setOwnPresence('unavailable', ''));
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'online',
        lastPresenceTs: 1,
      });

      presenceHandler(client)(undefined, { userId: SELF, presence: 'online' });
      await Promise.resolve();

      expect(state()).toBe('unavailable');
    });

    it('seeds myPresence and myStatusMessage from the client', () => {
      const { svc, client } = setup();
      client.getUser.mockReturnValue({
        userId: SELF,
        presence: 'unavailable',
        presenceStatusMsg: 'brb',
        lastPresenceTs: 1_000,
        events: {
          presence: presenceEvent({
            presence: 'unavailable',
            status_msg: 'brb',
          }),
        },
      });
      svc.loadOwnPresence();
      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('brb');
    });

    it('defaults own presence to online when the server has none', () => {
      const { svc } = setup(); // getUser(self) → null
      svc.loadOwnPresence();
      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('publishes presence + trimmed status and updates the signals', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setOwnPresence('unavailable', '  heads down  '));
      expect(client.setPresence).toHaveBeenCalledWith({
        presence: 'unavailable',
        status_msg: 'heads down',
      });
      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('heads down');
    });

    // Per the spec, a sync that omits set_presence marks the user online, which would undo the choice
    // within seconds.
    it('keeps the chosen status in the client’s own syncs', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setOwnPresence('unavailable', ''));
      expect(client.setSyncPresence).toHaveBeenCalledWith('unavailable');
    });

    it('remembers the chosen status for the next session', async () => {
      const { svc, storage } = setup();
      await firstValueFrom(svc.setOwnPresence('unavailable', 'lunch'));
      expect(storage.ownPresence()).toEqual({
        presence: 'unavailable',
        statusMessage: 'lunch',
      });
      await firstValueFrom(svc.setOwnPresence('online', ''));
      expect(storage.ownPresence()).toBeNull();
    });

    it('sends the remembered status when the account connects', async () => {
      const { svc, client, storage } = setup();
      storage.saveOwnPresence({
        presence: 'unavailable',
        statusMessage: 'lunch',
      });
      svc.runProjection().subscribe();
      await vi.waitFor(() =>
        expect(client.setSyncPresence).toHaveBeenCalledWith('unavailable'),
      );
      expect(client.setPresence).toHaveBeenCalledWith({
        presence: 'unavailable',
        status_msg: 'lunch',
      });
      expect(svc.myPresence()).toBe('unavailable');
    });

    it('sends the remembered status only once per client, not on every account switch', async () => {
      const { svc, client, matrix, storage, activeUserId } = setup();
      storage.saveOwnPresence({ presence: 'unavailable', statusMessage: '' });
      svc.runProjection().subscribe();
      TestBed.inject(ApplicationRef).tick();
      await vi.waitFor(() => expect(client.setPresence).toHaveBeenCalledOnce());
      const other = fakeClient();
      other.getUserId.mockReturnValue('@other:hs');
      ngMocks.stubMember(matrix, 'instance', asClient(other));
      activeUserId.set('@other:hs');
      TestBed.inject(ApplicationRef).tick();
      ngMocks.stubMember(matrix, 'instance', asClient(client));
      activeUserId.set(SELF);
      TestBed.inject(ApplicationRef).tick();
      expect(client.on.mock.calls.length).toBeGreaterThan(1); // re-bound to it
      await Promise.resolve();
      await Promise.resolve();
      expect(client.setPresence).toHaveBeenCalledOnce();
    });

    it('keeps a status chosen while the remembered one is being sent', async () => {
      const { svc, client, storage } = setup();
      storage.saveOwnPresence({ presence: 'unavailable', statusMessage: '' });
      let finishRestore!: () => void;
      client.setPresence.mockReturnValueOnce(
        new Promise<void>((resolve) => (finishRestore = resolve)),
      );
      svc.runProjection().subscribe();
      await vi.waitFor(() => expect(client.setPresence).toHaveBeenCalledOnce());
      await firstValueFrom(svc.setOwnPresence('offline', ''));
      finishRestore();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.setSyncPresence).toHaveBeenLastCalledWith('offline');
      expect(client.setSyncPresence).not.toHaveBeenCalledWith('unavailable');
      expect(svc.myPresence()).toBe('offline');
      expect(storage.ownPresence()).toEqual({
        presence: 'offline',
        statusMessage: '',
      });
    });

    it('sends nothing on connect when no status was chosen', async () => {
      const { svc, client } = setup();
      svc.runProjection().subscribe();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.setPresence).not.toHaveBeenCalled();
    });

    it('leaves syncs alone when the server rejects the status', async () => {
      const { svc, client } = setup();
      client.setPresence.mockReturnValueOnce(Promise.reject(new Error('nope')));
      await firstValueFrom(svc.setOwnPresence('unavailable', '')).catch(
        () => undefined,
      );
      expect(client.setSyncPresence).not.toHaveBeenCalled();
    });

    it('omits an empty status message', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setOwnPresence('offline', '   '));
      expect(client.setPresence).toHaveBeenCalledWith({
        presence: 'offline',
        status_msg: undefined,
      });
      expect(svc.myStatusMessage()).toBe('');
    });

    it('clears own presence presentation when the projection disconnects', () => {
      const { svc } = setup(
        { [SELF]: 'unavailable' },
        { [SELF]: 'heads down' },
      );
      const lifetime = svc.runProjection().subscribe();
      svc.loadOwnPresence();

      lifetime.unsubscribe();

      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('does not publish a completed write into a newly active account', async () => {
      const { svc, client, activeUserId } = setup();
      let complete!: () => void;
      client.setPresence.mockReturnValue(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      const pending = firstValueFrom(
        svc.setOwnPresence('unavailable', 'old account'),
      );

      activeUserId.set('@next:hs');
      complete();
      await pending;

      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('is cold — nothing is sent until subscribed', () => {
      const { svc, client } = setup();
      svc.setOwnPresence('online', 'hi'); // not subscribed
      expect(client.setPresence).not.toHaveBeenCalled();
    });

    it('maps a disabled presence endpoint to an unavailable failure', async () => {
      const { svc, client } = setup();
      client.setPresence.mockRejectedValue({ errcode: 'M_UNRECOGNIZED' });

      await expect(
        firstValueFrom(svc.setOwnPresence('online', 'hi')),
      ).rejects.toMatchObject({
        operation: 'set-presence',
        kind: 'unavailable',
        recovery: 'none',
      });
    });
  });
});
