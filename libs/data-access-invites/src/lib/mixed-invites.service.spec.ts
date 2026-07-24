import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MixedInvitesService } from './mixed-invites.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

type Listener = (...args: unknown[]) => void;

/** An invited room shaped like the bits buildInvite() reads. */
function fakeInvite(
  roomId: string,
  opts: { name?: string; membership?: string; myUserId?: string } = {},
) {
  const me = opts.myUserId ?? '@me:hs';
  return {
    roomId,
    name: opts.name ?? roomId,
    isSpaceRoom: () => false,
    getMyMembership: () => opts.membership ?? 'invite',
    getMxcAvatarUrl: () => null,
    getMember: (id: string) =>
      id === me
        ? {
            name: me,
            events: {
              member: {
                getSender: () => '@inviter:hs',
                getContent: () => ({ is_direct: false }),
              },
            },
          }
        : { name: 'Inviter' },
  };
}

function fakeClient(rooms: ReturnType<typeof fakeInvite>[], userId: string) {
  const handlers = new Map<string, Set<Listener>>();
  return {
    getUserId: () => userId,
    getRooms: () => rooms,
    on(evt: string, handler: Listener) {
      (handlers.get(evt) ?? handlers.set(evt, new Set()).get(evt)!).add(
        handler,
      );
    },
    off(evt: string, handler: Listener) {
      handlers.get(evt)?.delete(handler);
    },
    emit(evt: string) {
      handlers.get(evt)?.forEach((h) => h());
    },
    listenerCount() {
      let total = 0;
      handlers.forEach((set) => (total += set.size));
      return total;
    },
  };
}

function harness(): {
  svc: MixedInvitesService;
  accountIds: WritableSignal<readonly string[]>;
  activeUserId: WritableSignal<string | null>;
  clients: Map<string, ReturnType<typeof fakeClient>>;
  flush: () => Promise<void>;
} {
  const accountIds = signal<readonly string[]>([]);
  const activeUserId = signal<string | null>(null);
  const clients = new Map<string, ReturnType<typeof fakeClient>>();
  const matrix = {
    accountIds: accountIds.asReadonly(),
    activeUserId: activeUserId.asReadonly(),
    clientFor: (id: string) => clients.get(id) ?? null,
  } as unknown as MatrixClientService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      MixedInvitesService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(MixedInvitesService);
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { svc, accountIds, activeUserId, clients, flush };
}

describe('MixedInvitesService', () => {
  it('stays empty and attaches nothing until accounts are selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeInvite('!i:hs')], '@a:hs'));
    accountIds.set(['@a:hs']);
    await flush();

    expect(svc.invites()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });

  // The point of the feature: an invite to an account you are SHOWING but not acting as
  // would otherwise be invisible everywhere until you happened to switch to it.
  it('surfaces every selected account’s invites, tagged with the account', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([fakeInvite('!ia:hs', { name: 'Alpha' })], '@a:hs'),
    );
    clients.set(
      '@b:hs',
      fakeClient(
        [
          fakeInvite('!ib:hs', { name: 'Bravo', myUserId: '@b:hs' }),
          fakeInvite('!joined:hs', {
            name: 'Joined',
            membership: 'join',
            myUserId: '@b:hs',
          }),
        ],
        '@b:hs',
      ),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    // Sorted by name; joined rooms are not invites.
    expect(svc.invites().map((i) => [i.roomId, i.accountId])).toEqual([
      ['!ia:hs', '@a:hs'],
      ['!ib:hs', '@b:hs'],
    ]);
  });

  it('ignores signed-in accounts that are not selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeInvite('!ia:hs')], '@a:hs'));
    clients.set('@b:hs', fakeClient([fakeInvite('!ib:hs')], '@b:hs'));
    clients.set('@c:hs', fakeClient([fakeInvite('!ic:hs')], '@c:hs'));
    accountIds.set(['@a:hs', '@b:hs', '@c:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(
      svc
        .invites()
        .map((i) => i.roomId)
        .sort(),
    ).toEqual(['!ia:hs', '!ib:hs']);
    expect(clients.get('@c:hs')!.listenerCount()).toBe(0);
  });

  it('detaches and empties when the mix drops below two accounts', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeInvite('!ia:hs')], '@a:hs'));
    clients.set('@b:hs', fakeClient([fakeInvite('!ib:hs')], '@b:hs'));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(svc.invites().length).toBe(2);

    svc.setAccounts(new Set(['@a:hs']));
    expect(svc.invites()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
    expect(clients.get('@b:hs')!.listenerCount()).toBe(0);
  });

  // A re-added account gets a NEW client object under the same user id; keeping the old one
  // strands the listener on a stopped client and that account's invites stop arriving.
  it('re-attaches when an account’s client object is replaced', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const first = fakeClient([fakeInvite('!ia:hs')], '@a:hs');
    clients.set('@a:hs', first);
    clients.set('@b:hs', fakeClient([fakeInvite('!ib:hs')], '@b:hs'));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(first.listenerCount()).toBeGreaterThan(0);

    const replacement = fakeClient([fakeInvite('!ia2:hs')], '@a:hs');
    clients.set('@a:hs', replacement);
    clients.get('@b:hs')!.emit('sync'); // nudge a re-reconcile
    await flush();

    expect(first.listenerCount()).toBe(0);
    expect(replacement.listenerCount()).toBeGreaterThan(0);
    expect(
      svc
        .invites()
        .map((i) => i.roomId)
        .sort(),
    ).toEqual(['!ia2:hs', '!ib:hs']);
  });
});
