import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountProfilesService } from './account-profiles.service';

interface FakeProfile {
  displayName?: string;
  avatarUrl?: string | null;
}

/**
 * A client stub for one account, with `on`/`off` spies so listeners are assertable.
 *
 * `getUser` RESPECTS its argument: reading a client for the wrong user id is the bug class
 * this service exists to prevent, and a stub that answers for anyone cannot see it.
 */
function fakeClient(ownId: string, profile: FakeProfile | null) {
  return {
    ownId,
    getUser: (userId: string) => (userId === ownId ? profile : null),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function setup(
  accounts: Record<string, ReturnType<typeof fakeClient>>,
  /** Signed-in ids whose client is not created yet — `clientFor` returns null for these. */
  idsWithoutClients: string[] = [],
) {
  const ids = signal<readonly string[]>([
    ...Object.keys(accounts),
    ...idsWithoutClients,
  ]);
  const active = signal<string | null>(null);
  const clients = new Map(Object.entries(accounts));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      AccountProfilesService,
      MockProvider(MatrixClientService, {
        accountIds: ids.asReadonly(),
        activeUserId: active.asReadonly(),
        clientFor: (userId: string) => (clients.get(userId) ?? null) as never,
      }),
    ],
  });
  const svc = TestBed.inject(AccountProfilesService);
  // The projection wires itself from a constructor effect, which has not run yet.
  TestBed.tick();
  return { svc, ids, active, clients };
}

/** Pull a captured listener by event name. */
function handlerFor(
  client: { on: ReturnType<typeof vi.fn> },
  event: string,
): ((e: unknown, user: { userId: string }) => void) | undefined {
  const call = client.on.mock.calls.find(([e]) => e === event);
  return call?.[1];
}

describe('AccountProfilesService', () => {
  it('reads every signed-in account through its own client', () => {
    const { svc } = setup({
      '@me:hs': fakeClient('@me:hs', {
        displayName: 'Me',
        avatarUrl: 'mxc://hs/me',
      }),
      '@alt:hs': fakeClient('@alt:hs', { displayName: 'Alt', avatarUrl: null }),
    });

    expect(svc.profileOf('@me:hs')).toEqual({
      userId: '@me:hs',
      displayName: 'Me',
      avatarMxc: 'mxc://hs/me',
    });
    expect(svc.profileOf('@alt:hs').displayName).toBe('Alt');
  });

  it('falls back to the user id before a profile has hydrated', () => {
    const { svc } = setup({ '@alt:hs': fakeClient('@alt:hs', null) });

    expect(svc.profileOf('@alt:hs')).toEqual({
      userId: '@alt:hs',
      displayName: '@alt:hs',
      avatarMxc: null,
    });
  });

  it('follows a display-name change on the account it belongs to', async () => {
    const client = fakeClient('@alt:hs', null);
    const { svc } = setup({ '@alt:hs': client });
    expect(svc.profileOf('@alt:hs').displayName).toBe('@alt:hs');

    // The profile hydrates on THAT account's sync, which is what the counter this
    // replaced could not see — it was bumped only by the active client.
    client.getUser = (id) =>
      id === '@alt:hs' ? { displayName: 'Alice', avatarUrl: 'mxc://a' } : null;
    handlerFor(client, 'User.displayName')?.({}, { userId: '@alt:hs' });
    await Promise.resolve();

    expect(svc.profileOf('@alt:hs').displayName).toBe('Alice');
    expect(svc.profileOf('@alt:hs').avatarMxc).toBe('mxc://a');
  });

  it('ignores an event about somebody else on the same client', async () => {
    // The client re-emits these for every user it knows — everyone in every room — so an
    // unfiltered handler would rebuild on other people's profile changes.
    const client = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    const before = svc.profiles();

    client.getUser = (id) =>
      id === '@me:hs' ? { displayName: 'Changed', avatarUrl: null } : null;
    handlerFor(client, 'User.displayName')?.({}, { userId: '@someone:hs' });
    // Flushed BEFORE asserting: the rebuild is coalesced onto a microtask, so this would
    // pass against an unflushed turn whether or not the filter works.
    await Promise.resolve();

    expect(svc.profiles()).toBe(before);
  });

  it('holds the same map when a rebuild changes nothing', async () => {
    const client = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    const before = svc.profiles();

    handlerFor(client, 'User.avatarUrl')?.({}, { userId: '@me:hs' });
    await Promise.resolve();

    expect(svc.profiles()).toBe(before);
  });

  it('collapses a burst into one rebuild', async () => {
    const client = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    let reads = 0;
    client.getUser = (id) => {
      reads += 1;
      return id === '@me:hs' ? { displayName: 'Me', avatarUrl: null } : null;
    };

    const onName = handlerFor(client, 'User.displayName');
    onName?.({}, { userId: '@me:hs' });
    onName?.({}, { userId: '@me:hs' });
    onName?.({}, { userId: '@me:hs' });
    await Promise.resolve();

    expect(reads).toBe(1);
    expect(svc.profileOf('@me:hs').displayName).toBe('Me');
  });

  it('detaches from an account that signs out', () => {
    const client = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const { svc, ids, clients } = setup({ '@me:hs': client });

    clients.delete('@me:hs');
    ids.set([]);
    TestBed.tick();

    expect(client.off).toHaveBeenCalledWith(
      'User.displayName',
      expect.any(Function),
    );
    expect(client.off).toHaveBeenCalledWith(
      'User.avatarUrl',
      expect.any(Function),
    );
    expect(svc.profiles().size).toBe(0);
  });

  it('rebinds when the same account gets a new client object', async () => {
    // Re-adding an already signed-in account stops and re-creates its client. Holding the
    // old one strands the listener on a stopped client and that account silently freezes.
    const first = fakeClient('@me:hs', { displayName: 'Old', avatarUrl: null });
    const { svc, active, clients } = setup({ '@me:hs': first });

    const second = fakeClient('@me:hs', {
      displayName: 'New',
      avatarUrl: null,
    });
    clients.set('@me:hs', second);
    // Driving the ACTIVE ACCOUNT, not the id list — the id list is genuinely unchanged
    // when an account is re-added, so `activeUserId` is what has to re-run the effect.
    // Writing `ids.set([...])` instead would pass on array identity alone and leave that
    // dependency unpinned.
    active.set('@me:hs');
    TestBed.tick();

    expect(first.off).toHaveBeenCalled();
    expect(second.on).toHaveBeenCalled();

    second.getUser = (id) =>
      id === '@me:hs' ? { displayName: 'Newer', avatarUrl: null } : null;
    handlerFor(second, 'User.displayName')?.({}, { userId: '@me:hs' });
    await Promise.resolve();

    expect(svc.profileOf('@me:hs').displayName).toBe('Newer');
  });

  it('follows the account\u2019s own profile hydrating on sync', async () => {
    // THE case, and the one the UserEvent listeners cannot cover: the client seeds its own
    // user with `new User(id)` rather than `User.createUser`, so it has no re-emitter and
    // `User.displayName` never reaches a client-level listener for it. Before the sync
    // trigger existed, the header chip and every account badge showed the raw mxid for the
    // whole session.
    const client = fakeClient('@me:hs', {
      displayName: '@me:hs',
      avatarUrl: null,
    });
    const { svc } = setup({ '@me:hs': client });
    expect(svc.profileOf('@me:hs').displayName).toBe('@me:hs');

    client.getUser = (id) =>
      id === '@me:hs' ? { displayName: 'Me', avatarUrl: 'mxc://me' } : null;
    handlerFor(client, 'sync')?.({}, { userId: '' } as never);
    await Promise.resolve();

    expect(svc.profileOf('@me:hs').displayName).toBe('Me');
    expect(svc.profileOf('@me:hs').avatarMxc).toBe('mxc://me');
  });

  it('hears a BACKGROUND account sync without the active one syncing', async () => {
    // Each account gets its own sync listener, which is the whole point: the counter this
    // replaced was bumped by the active client only.
    const me = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const alt = fakeClient('@alt:hs', null);
    const { svc } = setup({ '@me:hs': me, '@alt:hs': alt });

    alt.getUser = (id) =>
      id === '@alt:hs' ? { displayName: 'Alt', avatarUrl: null } : null;
    handlerFor(alt, 'sync')?.({}, { userId: '' } as never);
    await Promise.resolve();

    expect(svc.profileOf('@alt:hs').displayName).toBe('Alt');
  });

  it('detaches the sync listener too', () => {
    const client = fakeClient('@me:hs', { displayName: 'Me', avatarUrl: null });
    const { ids, clients } = setup({ '@me:hs': client });

    clients.delete('@me:hs');
    ids.set([]);
    TestBed.tick();

    expect(client.off).toHaveBeenCalledWith('sync', expect.any(Function));
  });

  it('skips an account whose client is not live yet, and picks it up later', () => {
    // Signed in but not started — `clientFor` returns null. The account must still appear
    // (as its mxid) rather than being dropped, and must gain a listener once its client
    // exists. The earlier version of this test passed no such id at all, so neither loop
    // body ran and the guard it named was never reached.
    const { svc, ids, clients } = setup({}, ['@pending:hs']);
    expect(svc.profileOf('@pending:hs').displayName).toBe('@pending:hs');

    const late = fakeClient('@pending:hs', {
      displayName: 'Pending',
      avatarUrl: null,
    });
    clients.set('@pending:hs', late);
    ids.set(['@pending:hs']);
    TestBed.tick();

    expect(late.on).toHaveBeenCalled();
    expect(svc.profileOf('@pending:hs').displayName).toBe('Pending');
  });
});
