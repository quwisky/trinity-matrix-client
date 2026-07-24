import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import {
  AccountScopeService,
  RoomsService,
  UnreadAggregatorService,
} from '@trinity/data-access-rooms';
import { AccountBadgesService } from './account-badges.service';

interface FakeUser {
  displayName?: string;
  avatarUrl?: string | null;
}

function harness(opts: {
  mixing?: boolean;
  selected?: string[];
  users?: Record<string, FakeUser>;
}) {
  const mixing = signal(opts.mixing ?? true);
  const selected = signal<ReadonlySet<string>>(new Set(opts.selected ?? []));
  const revision = signal(0);
  const unreadByAccount = signal<ReadonlyMap<string, number>>(new Map());
  const users = opts.users ?? {};

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      AccountBadgesService,
      MockProvider(AccountScopeService, {
        mixing: mixing.asReadonly(),
        selected: selected.asReadonly(),
      }),
      MockProvider(RoomsService, { revision: revision.asReadonly() }),
      MockProvider(UnreadAggregatorService, {
        unreadByAccount: unreadByAccount.asReadonly(),
      }),
      MockProvider(MatrixClientService, {
        clientFor: (id: string) =>
          ({ getUser: () => users[id] ?? null }) as never,
      }),
    ],
  });

  return {
    svc: TestBed.inject(AccountBadgesService),
    mixing: mixing as WritableSignal<boolean>,
    revision,
    unreadByAccount,
    users,
  };
}

describe('AccountBadgesService', () => {
  it('is empty when a single account is in view — a badge would say nothing', () => {
    const { svc } = harness({ mixing: false, selected: ['@me:hs'] });

    expect(svc.badges().size).toBe(0);
    expect(svc.forAccount('@me:hs')).toBeNull();
  });

  it('builds a badge per selected account from its own profile', () => {
    const { svc } = harness({
      selected: ['@me:hs', '@alt:hs'],
      users: {
        '@me:hs': { displayName: 'Me', avatarUrl: 'mxc://hs/me' },
        '@alt:hs': { displayName: 'Alt', avatarUrl: null },
      },
    });

    expect(svc.forAccount('@me:hs')).toEqual({
      id: '@me:hs',
      name: 'Me',
      initial: 'M',
      avatarMxc: 'mxc://hs/me',
    });
    expect(svc.forAccount('@alt:hs')?.initial).toBe('A');
  });

  it('falls back to the user id before a profile has hydrated', () => {
    const { svc } = harness({ selected: ['@alt:hs'], users: {} });

    expect(svc.forAccount('@alt:hs')?.name).toBe('@alt:hs');
    expect(svc.forAccount('@alt:hs')?.initial).toBe('A');
  });

  // The mixed-in account's own sync is what hydrates its profile, and that never touches
  // RoomsService.revision (the ACTIVE client's signal). Without a cross-account trigger the
  // badge would keep the mxid and a hashed letter until the active account happened to sync.
  it('re-reads a profile that hydrates on another account’s sync', () => {
    const { svc, unreadByAccount, users } = harness({
      selected: ['@alt:hs'],
      users: {},
    });
    expect(svc.forAccount('@alt:hs')?.name).toBe('@alt:hs');

    users['@alt:hs'] = { displayName: 'Alice', avatarUrl: 'mxc://hs/alice' };
    unreadByAccount.set(new Map([['@alt:hs', 1]])); // @alt's own sync flushed

    expect(svc.forAccount('@alt:hs')?.name).toBe('Alice');
    expect(svc.forAccount('@alt:hs')?.avatarMxc).toBe('mxc://hs/alice');
  });

  it('also re-reads on the active account’s own revision bump', () => {
    const { svc, revision, users } = harness({
      selected: ['@me:hs'],
      users: {},
    });
    expect(svc.forAccount('@me:hs')?.name).toBe('@me:hs');

    users['@me:hs'] = { displayName: 'Me' };
    revision.set(1);

    expect(svc.forAccount('@me:hs')?.name).toBe('Me');
  });
});
