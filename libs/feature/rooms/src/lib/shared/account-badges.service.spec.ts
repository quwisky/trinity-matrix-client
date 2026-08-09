import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import {
  AccountProfilesService,
  type AccountProfile,
} from '@trinity/data-access/profile';
import { AccountScopeService } from '@trinity/data-access/rooms';
import { AccountBadgesService } from './account-badges.service';

function profileMap(
  entries: Record<string, { displayName?: string; avatarMxc?: string | null }>,
): ReadonlyMap<string, AccountProfile> {
  return new Map(
    Object.entries(entries).map(([userId, p]) => [
      userId,
      {
        userId,
        displayName: p.displayName ?? userId,
        avatarMxc: p.avatarMxc ?? null,
      },
    ]),
  );
}

function harness(opts: {
  mixing?: boolean;
  selected?: string[];
  profiles?: Record<
    string,
    { displayName?: string; avatarMxc?: string | null }
  >;
}) {
  const mixing = signal(opts.mixing ?? true);
  const selected = signal<ReadonlySet<string>>(new Set(opts.selected ?? []));
  // A signal a test can DRIVE: the badge's whole job is to follow a profile that
  // hydrates later, so a fixed map could not tell a working badge from a frozen one.
  const profiles = signal(profileMap(opts.profiles ?? {}));

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      AccountBadgesService,
      MockProvider(AccountScopeService, {
        mixing: mixing.asReadonly(),
        selected: selected.asReadonly(),
      }),
      MockProvider(AccountProfilesService, {
        profiles: profiles.asReadonly(),
      }),
    ],
  });

  return {
    svc: TestBed.inject(AccountBadgesService),
    mixing: mixing as WritableSignal<boolean>,
    selected,
    profiles,
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
      profiles: {
        '@me:hs': { displayName: 'Me', avatarMxc: 'mxc://hs/me' },
        '@alt:hs': { displayName: 'Alt', avatarMxc: null },
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
    const { svc } = harness({ selected: ['@alt:hs'], profiles: {} });

    expect(svc.forAccount('@alt:hs')?.name).toBe('@alt:hs');
    expect(svc.forAccount('@alt:hs')?.initial).toBe('A');
  });

  // A mixed-in account's OWN sync is what hydrates its profile. The counter this replaced
  // was bumped only by the active client, so the badge kept the mxid and a hashed letter
  // until the active account happened to sync — and only stayed usable because the service
  // also read the unread aggregator, which every client feeds. The projection listens per
  // account, so the badge now follows the thing it displays.
  it('follows a profile that hydrates later', () => {
    const { svc, profiles } = harness({ selected: ['@alt:hs'], profiles: {} });
    expect(svc.forAccount('@alt:hs')?.name).toBe('@alt:hs');

    profiles.set(
      profileMap({
        '@alt:hs': { displayName: 'Alice', avatarMxc: 'mxc://hs/alice' },
      }),
    );

    expect(svc.forAccount('@alt:hs')?.name).toBe('Alice');
    expect(svc.forAccount('@alt:hs')?.avatarMxc).toBe('mxc://hs/alice');
  });

  it('adds a badge when another account is ticked into the mixed view', () => {
    // `selected` and `mixing` have to be read INSIDE the computed. Hoisted into a field
    // they would snapshot at construction, and the badge set would never follow the
    // picker — which is what the harness's own comment warns about and then did not test.
    const { svc, selected } = harness({
      selected: ['@me:hs'],
      profiles: {
        '@me:hs': { displayName: 'Me' },
        '@alt:hs': { displayName: 'Alt' },
      },
    });
    expect(svc.badges().size).toBe(1);

    selected.set(new Set(['@me:hs', '@alt:hs']));

    expect(svc.badges().size).toBe(2);
    expect(svc.forAccount('@alt:hs')?.name).toBe('Alt');
  });

  it('empties when mixed mode is turned off', () => {
    const { svc, mixing } = harness({
      selected: ['@me:hs', '@alt:hs'],
      profiles: { '@me:hs': {}, '@alt:hs': {} },
    });
    expect(svc.badges().size).toBe(2);

    mixing.set(false);

    expect(svc.badges().size).toBe(0);
  });
});
