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

/** A client stub for one account, with `on`/`off` spies so listeners are assertable. */
function fakeClient(profile: FakeProfile | null) {
  return {
    getUser: () => profile,
    on: vi.fn(),
    off: vi.fn(),
  };
}

function setup(accounts: Record<string, ReturnType<typeof fakeClient>>) {
  const ids = signal<readonly string[]>(Object.keys(accounts));
  const clients = new Map(Object.entries(accounts));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      AccountProfilesService,
      MockProvider(MatrixClientService, {
        accountIds: ids.asReadonly(),
        activeUserId: signal<string | null>(null).asReadonly(),
        clientFor: (userId: string) => (clients.get(userId) ?? null) as never,
      }),
    ],
  });
  const svc = TestBed.inject(AccountProfilesService);
  // The projection wires itself from a constructor effect, which has not run yet.
  TestBed.flushEffects();
  return { svc, ids, clients };
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
      '@me:hs': fakeClient({ displayName: 'Me', avatarUrl: 'mxc://hs/me' }),
      '@alt:hs': fakeClient({ displayName: 'Alt', avatarUrl: null }),
    });

    expect(svc.profileOf('@me:hs')).toEqual({
      userId: '@me:hs',
      displayName: 'Me',
      avatarMxc: 'mxc://hs/me',
    });
    expect(svc.profileOf('@alt:hs').displayName).toBe('Alt');
  });

  it('falls back to the user id before a profile has hydrated', () => {
    const { svc } = setup({ '@alt:hs': fakeClient(null) });

    expect(svc.profileOf('@alt:hs')).toEqual({
      userId: '@alt:hs',
      displayName: '@alt:hs',
      avatarMxc: null,
    });
  });

  it('follows a display-name change on the account it belongs to', async () => {
    const client = fakeClient(null);
    const { svc } = setup({ '@alt:hs': client });
    expect(svc.profileOf('@alt:hs').displayName).toBe('@alt:hs');

    // The profile hydrates on THAT account's sync, which is what the counter this
    // replaced could not see — it was bumped only by the active client.
    client.getUser = () => ({ displayName: 'Alice', avatarUrl: 'mxc://a' });
    handlerFor(client, 'User.displayName')?.({}, { userId: '@alt:hs' });
    await Promise.resolve();

    expect(svc.profileOf('@alt:hs').displayName).toBe('Alice');
    expect(svc.profileOf('@alt:hs').avatarMxc).toBe('mxc://a');
  });

  it('ignores an event about somebody else on the same client', async () => {
    // The client re-emits these for every user it knows — everyone in every room — so an
    // unfiltered handler would rebuild on other people's profile changes.
    const client = fakeClient({ displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    const before = svc.profiles();

    client.getUser = () => ({ displayName: 'Changed', avatarUrl: null });
    handlerFor(client, 'User.displayName')?.({}, { userId: '@someone:hs' });
    // Flushed BEFORE asserting: the rebuild is coalesced onto a microtask, so this would
    // pass against an unflushed turn whether or not the filter works.
    await Promise.resolve();

    expect(svc.profiles()).toBe(before);
  });

  it('holds the same map when a rebuild changes nothing', async () => {
    const client = fakeClient({ displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    const before = svc.profiles();

    handlerFor(client, 'User.avatarUrl')?.({}, { userId: '@me:hs' });
    await Promise.resolve();

    expect(svc.profiles()).toBe(before);
  });

  it('collapses a burst into one rebuild', async () => {
    const client = fakeClient({ displayName: 'Me', avatarUrl: null });
    const { svc } = setup({ '@me:hs': client });
    let reads = 0;
    client.getUser = () => {
      reads += 1;
      return { displayName: 'Me', avatarUrl: null };
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
    const client = fakeClient({ displayName: 'Me', avatarUrl: null });
    const { svc, ids, clients } = setup({ '@me:hs': client });

    clients.delete('@me:hs');
    ids.set([]);
    TestBed.flushEffects();

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
    const first = fakeClient({ displayName: 'Old', avatarUrl: null });
    const { svc, ids, clients } = setup({ '@me:hs': first });

    const second = fakeClient({ displayName: 'New', avatarUrl: null });
    clients.set('@me:hs', second);
    // The id list is unchanged, so the switch is what has to trigger the re-check.
    ids.set(['@me:hs']);
    TestBed.flushEffects();

    expect(first.off).toHaveBeenCalled();
    expect(second.on).toHaveBeenCalled();

    second.getUser = () => ({ displayName: 'Newer', avatarUrl: null });
    handlerFor(second, 'User.displayName')?.({}, { userId: '@me:hs' });
    await Promise.resolve();

    expect(svc.profileOf('@me:hs').displayName).toBe('Newer');
  });

  it('skips an account whose client is not live yet', () => {
    const { svc } = setup({});
    const ids = TestBed.inject(MatrixClientService).accountIds;

    expect(() => ids()).not.toThrow();
    expect(svc.profileOf('@nobody:hs').displayName).toBe('@nobody:hs');
  });
});
