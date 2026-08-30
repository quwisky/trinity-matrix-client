import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountScopeService, sameAccountSet } from './account-scope.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { firstValueFrom } from 'rxjs';

const store = new Map<string, string>();
let failStorage = false;
let getCalls = 0;
let setCalls = 0;

// The service talks to @capacitor/preferences directly (the repo's preference pattern),
// so stub the plugin with an in-memory map rather than the whole native layer.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      getCalls += 1;
      if (failStorage) throw new Error('storage unavailable');
      return { value: store.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      setCalls += 1;
      if (failStorage) throw new Error('storage unavailable');
      store.set(key, value);
    },
  },
}));

const KEY = 'trinity.accounts.mixed';

function harness(
  accounts: string[],
  active: string | null = accounts[0] ?? null,
) {
  const accountIds = signal<readonly string[]>(accounts);
  const activeUserId = signal<string | null>(active);
  const matrix = {
    accountIds: accountIds.asReadonly(),
    activeUserId: activeUserId.asReadonly(),
  } as unknown as MatrixClientService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      AccountScopeService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return {
    svc: TestBed.inject(AccountScopeService),
    accountIds: accountIds as WritableSignal<readonly string[]>,
    activeUserId: activeUserId as WritableSignal<string | null>,
  };
}

describe('AccountScopeService', () => {
  beforeEach(() => {
    store.clear();
    failStorage = false;
    getCalls = 0;
    setCalls = 0;
  });

  it('shows only the active account until others are picked', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);

    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);
  });

  it('includes an account once it is selected, and mixes at two', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs').subscribe();

    expect([...svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
    expect(svc.mixing()).toBe(true);

    svc.toggle('@alt:hs').subscribe();
    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);
  });

  // The account you act as must stay visible — otherwise you'd be posting into a list
  // that can't show what you posted.
  it('refuses to hide the active account', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs').subscribe();

    svc.toggle('@me:hs').subscribe(); // attempt to drop the active account
    expect(svc.selected().has('@me:hs')).toBe(true);
  });

  it('keeps the newly active account shown after a switch', () => {
    const { svc, activeUserId } = harness(['@me:hs', '@alt:hs']);
    expect([...svc.selected()]).toEqual(['@me:hs']);

    // Opening a foreign account's room switches the active account; it must appear.
    activeUserId.set('@alt:hs');
    expect(svc.selected().has('@alt:hs')).toBe(true);
  });

  it('drops accounts that are no longer signed in, without forgetting them', () => {
    const { svc, accountIds } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs').subscribe();
    expect(svc.mixing()).toBe(true);

    // Signed out → stops contributing…
    accountIds.set(['@me:hs']);
    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);

    // …and returns to the mix when signed back in, rather than being silently forgotten.
    accountIds.set(['@me:hs', '@alt:hs']);
    expect(svc.selected().has('@alt:hs')).toBe(true);
  });

  // Turning the mix off must forget the active account too, or the next account switch
  // would pair it with the newly-active one and silently turn mixing back on.
  it('stays single-account after unticking, even across an account switch', () => {
    const { svc, activeUserId } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs').subscribe();
    svc.toggle('@alt:hs').subscribe(); // back off again
    expect(svc.mixing()).toBe(false);

    activeUserId.set('@alt:hs'); // user switches accounts from the switcher
    expect([...svc.selected()]).toEqual(['@alt:hs']);
    expect(svc.mixing()).toBe(false);
  });

  it('persists the selection and restores it on the next launch', async () => {
    const first = harness(['@me:hs', '@alt:hs']);
    first.svc.toggle('@alt:hs').subscribe();
    expect(store.get(KEY)).toBeDefined();

    // A fresh service (cold start) hydrates the same mix.
    const second = harness(['@me:hs', '@alt:hs']);
    expect([...second.svc.selected()]).toEqual(['@me:hs']); // not yet hydrated
    await firstValueFrom(second.svc.init());
    expect([...second.svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
  });

  // A soft-logged-out account is absent from accountIds(); pruning it on write would throw
  // away the user's pick for good, so the stored set keeps it and `selected` filters on read.
  it('keeps a signed-out account in storage so its pick survives re-authentication', () => {
    const { svc, accountIds } = harness(['@me:hs', '@alt:hs', '@away:hs']);
    svc.toggle('@alt:hs').subscribe();
    svc.toggle('@away:hs').subscribe();

    accountIds.set(['@me:hs', '@alt:hs']); // @away's token is revoked overnight
    expect(svc.selected().has('@away:hs')).toBe(false); // inert while signed out

    svc.toggle('@alt:hs').subscribe(); // any later write must not drop @away
    expect(JSON.parse(store.get(KEY) ?? '[]')).toContain('@away:hs');

    accountIds.set(['@me:hs', '@alt:hs', '@away:hs']); // re-authenticated
    expect(svc.selected().has('@away:hs')).toBe(true);
  });

  // The active account is only unioned in at read time, so it must be materialised into
  // storage when a mix is created — otherwise opening a mixed-in account's room (which
  // switches the active account) drops the account you were mixing FROM straight back out.
  it('survives the account switch that opening a mixed-in room performs', () => {
    const { svc, activeUserId } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs').subscribe();
    expect(svc.mixing()).toBe(true);

    activeUserId.set('@alt:hs'); // opening one of @alt's rooms switches to it
    expect([...svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
    expect(svc.mixing()).toBe(true); // the mix does NOT collapse
  });

  it('starts clean when the stored value is absent or corrupt', async () => {
    store.set(KEY, '{not json');
    const { svc } = harness(['@me:hs', '@alt:hs']);
    await firstValueFrom(svc.init());

    expect([...svc.selected()]).toEqual(['@me:hs']);
  });

  it('ignores non-string entries in a tampered stored value', async () => {
    store.set(KEY, JSON.stringify(['@alt:hs', 42, null]));
    const { svc } = harness(['@me:hs', '@alt:hs']);
    await firstValueFrom(svc.init());

    expect([...svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
  });

  it('keeps hydration and selection writes cold', async () => {
    store.set(KEY, JSON.stringify(['@alt:hs']));
    const { svc } = harness(['@me:hs', '@alt:hs']);

    const hydration = svc.init();
    const selection = svc.toggle('@alt:hs');
    expect(getCalls).toBe(0);
    expect(setCalls).toBe(0);
    expect([...svc.selected()]).toEqual(['@me:hs']);

    await firstValueFrom(hydration);
    expect(getCalls).toBe(1);
    await firstValueFrom(selection);
    expect(setCalls).toBe(1);
  });

  it('surfaces selection persistence failures to the subscriber', async () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);
    failStorage = true;

    await expect(firstValueFrom(svc.toggle('@alt:hs'))).rejects.toThrow(
      'storage unavailable',
    );
  });
});

describe('sameAccountSet', () => {
  it('compares membership, not identity or order', () => {
    expect(sameAccountSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameAccountSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameAccountSet(new Set(['a']), new Set(['b']))).toBe(false);
    expect(sameAccountSet(new Set(), new Set())).toBe(true);
  });
});
