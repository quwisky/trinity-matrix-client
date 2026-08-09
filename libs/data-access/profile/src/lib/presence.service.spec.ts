import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { UserEvent, type MatrixClient } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceService } from './presence.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * The fakes here implement only the slice of MatrixClient the service touches, so the
 * widening cast lives at this one visible seam rather than implicitly at every stub site.
 */
const asClient = (fake: object): MatrixClient =>
  fake as unknown as MatrixClient;

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
    getUser: vi.fn((id: string) =>
      id in users
        ? { userId: id, presence: users[id], presenceStatusMsg: statuses[id] }
        : null,
    ),
    setPresence: vi.fn(() => Promise.resolve()),
  };
}

function setup(
  users: Record<string, string> = {},
  statuses: Record<string, string> = {},
) {
  const client = fakeClient(users, statuses);
  const activeUserId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      PresenceService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'instance', asClient(client));
  ngMocks.stubMember(matrix, 'isInitialized', true);
  return { svc: TestBed.inject(PresenceService), client, matrix, activeUserId };
}

/** The `User.presence` handler the service registered on the client. */
function presenceHandler(client: ReturnType<typeof fakeClient>) {
  return client.on.mock.calls.find((c) => c[0] === UserEvent.Presence)?.[1] as (
    event: unknown,
    user: { userId: string; presence: string },
  ) => void;
}

describe('PresenceService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reports the signed-in user as online even when the server never echoes our own presence', () => {
    // getUser(self) is null/offline here (homeservers typically don't send you your
    // own presence), but we ARE online while our client runs — self must read online.
    const { svc } = setup();
    expect(svc.presenceFor(SELF)()).toBe('online');
  });

  it('keeps the signed-in user online even if a self presence event says otherwise', () => {
    const { svc, client } = setup();
    const state = svc.presenceFor(SELF);
    svc.connect();
    presenceHandler(client)(undefined, { userId: SELF, presence: 'offline' });
    expect(state()).toBe('online');
  });

  it('seeds presence from the client, defaulting unknown users to offline', () => {
    const { svc } = setup({ '@online:hs': 'online' });
    expect(svc.presenceFor('@online:hs')()).toBe('online');
    expect(svc.presenceFor('@stranger:hs')()).toBe('offline');
  });

  it('memoizes the signal per user id', () => {
    const { svc } = setup();
    expect(svc.presenceFor('@a:hs')).toBe(svc.presenceFor('@a:hs'));
  });

  it('updates a tracked user’s signal when a presence event arrives', () => {
    const { svc, client } = setup();
    const state = svc.presenceFor('@a:hs'); // track it (starts offline)
    expect(state()).toBe('offline');

    svc.connect();
    presenceHandler(client)(undefined, { userId: '@a:hs', presence: 'online' });
    expect(state()).toBe('online');

    presenceHandler(client)(undefined, {
      userId: '@a:hs',
      presence: 'unavailable',
    });
    expect(state()).toBe('unavailable');
  });

  it('ignores presence for users nobody is watching', () => {
    const { svc, client } = setup();
    svc.connect();
    // No throw, and no signal is created for an untracked user.
    expect(() =>
      presenceHandler(client)(undefined, {
        userId: '@nobody:hs',
        presence: 'online',
      }),
    ).not.toThrow();
  });

  it('connect wires exactly one presence listener and is idempotent per client', () => {
    const { svc, client } = setup();
    svc.connect();
    svc.connect();
    expect(
      client.on.mock.calls.filter((c) => c[0] === UserEvent.Presence),
    ).toHaveLength(1);
  });

  it('disconnect detaches the listener', () => {
    const { svc, client } = setup();
    svc.connect();
    svc.disconnect();
    expect(client.off).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    );
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const { svc, client, matrix, activeUserId } = setup({ '@a:hs': 'online' });
    activeUserId.set('@a:hs');
    svc.connect(); // wired to the first client
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
    svc.connect();
    expect(state()).toBe('online');

    // A re-login hands the service a new client where @a is now offline.
    const client2 = fakeClient({ '@a:hs': 'offline' });
    ngMocks.stubMember(matrix, 'instance', asClient(client2));
    svc.connect();

    expect(client.off).toHaveBeenCalledWith(
      UserEvent.Presence,
      expect.any(Function),
    );
    expect(state()).toBe('offline'); // re-seeded from the new client
  });

  describe('own presence', () => {
    it('seeds myPresence and myStatusMessage from the client', () => {
      const { svc } = setup({ [SELF]: 'unavailable' }, { [SELF]: 'brb' });
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

    it('omits an empty status message', async () => {
      const { svc, client } = setup();
      await firstValueFrom(svc.setOwnPresence('offline', '   '));
      expect(client.setPresence).toHaveBeenCalledWith({
        presence: 'offline',
        status_msg: undefined,
      });
      expect(svc.myStatusMessage()).toBe('');
    });

    it('is cold — nothing is sent until subscribed', () => {
      const { svc, client } = setup();
      svc.setOwnPresence('online', 'hi'); // not subscribed
      expect(client.setPresence).not.toHaveBeenCalled();
    });
  });
});
