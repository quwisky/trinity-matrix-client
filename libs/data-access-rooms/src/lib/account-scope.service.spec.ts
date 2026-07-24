import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountScopeService, sameAccountSet } from './account-scope.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

const store = new Map<string, string>();

// The service talks to @capacitor/preferences directly (the repo's preference pattern),
// so stub the plugin with an in-memory map rather than the whole native layer.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: store.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
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
  beforeEach(() => store.clear());

  it('shows only the active account until others are picked', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);

    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);
  });

  it('includes an account once it is selected, and mixes at two', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs');

    expect([...svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
    expect(svc.mixing()).toBe(true);

    svc.toggle('@alt:hs');
    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);
  });

  // The account you act as must stay visible — otherwise you'd be posting into a list
  // that can't show what you posted.
  it('refuses to hide the active account', () => {
    const { svc } = harness(['@me:hs', '@alt:hs']);
    svc.toggle('@alt:hs');

    svc.toggle('@me:hs'); // attempt to drop the active account
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
    svc.toggle('@alt:hs');
    expect(svc.mixing()).toBe(true);

    // Signed out → stops contributing…
    accountIds.set(['@me:hs']);
    expect([...svc.selected()]).toEqual(['@me:hs']);
    expect(svc.mixing()).toBe(false);

    // …and returns to the mix when signed back in, rather than being silently forgotten.
    accountIds.set(['@me:hs', '@alt:hs']);
    expect(svc.selected().has('@alt:hs')).toBe(true);
  });

  it('persists the selection and restores it on the next launch', async () => {
    const first = harness(['@me:hs', '@alt:hs']);
    first.svc.toggle('@alt:hs');
    expect(store.get(KEY)).toBeDefined();

    // A fresh service (cold start) hydrates the same mix.
    const second = harness(['@me:hs', '@alt:hs']);
    expect([...second.svc.selected()]).toEqual(['@me:hs']); // not yet hydrated
    await second.svc.init();
    expect([...second.svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
  });

  it('prunes signed-out accounts from what it writes', () => {
    const { svc, accountIds } = harness(['@me:hs', '@alt:hs', '@gone:hs']);
    svc.toggle('@alt:hs');
    svc.toggle('@gone:hs');

    accountIds.set(['@me:hs', '@alt:hs']); // @gone signs out
    svc.toggle('@me:hs'); // a no-op on the active account…
    svc.setSelected('@alt:hs', true); // …so force a write via an equal-but-explicit set
    svc.toggle('@alt:hs'); // real write
    expect(JSON.parse(store.get(KEY) ?? '[]')).not.toContain('@gone:hs');
  });

  it('starts clean when the stored value is absent or corrupt', async () => {
    store.set(KEY, '{not json');
    const { svc } = harness(['@me:hs', '@alt:hs']);
    await svc.init();

    expect([...svc.selected()]).toEqual(['@me:hs']);
  });

  it('ignores non-string entries in a tampered stored value', async () => {
    store.set(KEY, JSON.stringify(['@alt:hs', 42, null]));
    const { svc } = harness(['@me:hs', '@alt:hs']);
    await svc.init();

    expect([...svc.selected()].sort()).toEqual(['@alt:hs', '@me:hs']);
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
