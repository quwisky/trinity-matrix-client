import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  LocalDataWipeService,
  SessionStorageService,
} from '@trinity/platform-native';
import { FactoryResetService } from './factory-reset.service';
import { OidcClientService } from './oidc-client.service';

const OIDC_BINDING = {
  issuer: 'https://op',
  clientId: 'c1',
  redirectUri: 'https://app/sso-callback',
};
const ALICE = {
  baseUrl: 'https://hs',
  userId: '@alice:hs',
  deviceId: 'DEV1',
  cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
};
const ALICE_SESSION = {
  ...ALICE,
  accessToken: 'a-tok',
  refreshToken: 'a-refresh',
  oidc: OIDC_BINDING,
};

const CLEAN_IDB = { blocked: [], failed: [], enumerated: true };

/** Records the phase order so the ordering assertions can read it back. */
let calls: string[];

function setup(
  opts: {
    records?: unknown[];
    session?: unknown;
    idb?: { blocked: string[]; failed: string[]; enumerated: boolean };
    signOutAll?: () => ReturnType<typeof of>;
  } = {},
) {
  calls = [];
  TestBed.configureTestingModule({
    providers: [
      FactoryResetService,
      MockProvider(SessionStorageService, {
        list: vi.fn(() => {
          calls.push('list');
          return of(opts.records ?? [ALICE]) as never;
        }),
        load: vi.fn(() => of(opts.session ?? ALICE_SESSION) as never),
        clearAll: vi.fn(() => {
          calls.push('storage.clearAll');
          return of(opts.records ?? [ALICE]) as never;
        }),
      }),
      MockProvider(MatrixClientService, {
        stop: vi.fn(() => {
          calls.push('stop');
          return of(undefined);
        }),
        signOutAll:
          opts.signOutAll ??
          vi.fn(() => {
            calls.push('signOutAll');
            return of(undefined);
          }),
      }),
      MockProvider(LocalDataWipeService, {
        wipeIndexedDb: vi.fn(async () => {
          calls.push('wipeIndexedDb');
          return opts.idb ?? CLEAN_IDB;
        }),
        wipeKeyValueStores: vi.fn(async () => {
          calls.push('wipeKeyValueStores');
          return true;
        }),
        wipeServiceWorker: vi.fn(async () => {
          calls.push('wipeServiceWorker');
        }),
      }),
      MockProvider(OidcClientService, {
        revokeTokens: vi.fn(() => {
          calls.push('revokeTokens');
          return of(undefined);
        }),
      }),
    ],
  });
  return {
    svc: TestBed.inject(FactoryResetService),
    matrix: TestBed.inject(MatrixClientService),
    wipe: TestBed.inject(LocalDataWipeService),
    oidc: TestBed.inject(OidcClientService),
  };
}

describe('FactoryResetService', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the phases in the one order that works', async () => {
    // Asserted as the whole sequence rather than a set of indexOf comparisons: indexOf
    // returns -1 for a step that was DELETED, and -1 is less than everything, so pairwise
    // ordering assertions pass when the step they name has been removed entirely.
    //
    // Each adjacency is load-bearing. `list` before everything: the registry is the only
    // map from an account to its IndexedDB names and secure keys, and Electron's keychain
    // cannot be enumerated. `signOutAll` before `stop`: teardown empties the client
    // registry it reads, so afterwards it signs nothing out. `stop` before
    // `wipeIndexedDb`: that is what closes the crypto stores' connections.
    // `storage.clearAll` before `wipeKeyValueStores`: its per-account key removals are the
    // only thing reaching Electron's secret store, and Preferences.clear deletes the
    // registry naming them.
    const { svc } = setup();

    await firstValueFrom(svc.clearAllData());

    expect(calls).toEqual([
      'list',
      // signOutAll and revokeTokens are fired together inside the one 3s budget.
      'signOutAll',
      'revokeTokens',
      'stop',
      'wipeIndexedDb',
      'storage.clearAll',
      'wipeKeyValueStores',
      'wipeServiceWorker',
    ]);
  });

  it('finishes the wipe when a database is blocked, rather than half-erasing', async () => {
    // Deletes run concurrently, so by the time one reports blocked the others are already
    // gone. Aborting there would leave exactly the half-erased install an abort is meant to
    // avoid — and a registry pointing at stores that no longer exist. Finishing restarts to
    // a clean login, and the leftover is an orphan the next cold start sweeps.
    const { svc, wipe, matrix } = setup({
      idb: {
        blocked: ['matrix-js-sdk:trinity-sync:@alice:hs'],
        failed: [],
        enumerated: true,
      },
    });

    const report = await firstValueFrom(svc.clearAllData());

    expect(report.blocked).toEqual(['matrix-js-sdk:trinity-sync:@alice:hs']);
    expect(matrix.signOutAll).toHaveBeenCalled();
    expect(wipe.wipeKeyValueStores).toHaveBeenCalled();
    expect(wipe.wipeServiceWorker).toHaveBeenCalled();
  });

  it('revokes with the tokens read before the wipe, and only for OIDC accounts', async () => {
    const { svc, oidc } = setup();

    await firstValueFrom(svc.clearAllData());

    expect(oidc.revokeTokens).toHaveBeenCalledWith('https://hs', OIDC_BINDING, {
      accessToken: 'a-tok',
      refreshToken: 'a-refresh',
    });
    expect(calls.indexOf('revokeTokens')).toBeLessThan(
      calls.indexOf('storage.clearAll'),
    );
  });

  it('does not revoke for a password/SSO account', async () => {
    const { svc, oidc } = setup({ session: { ...ALICE, accessToken: 't' } });

    await firstValueFrom(svc.clearAllData());

    expect(oidc.revokeTokens).not.toHaveBeenCalled();
  });

  it('completes the wipe when the sign-out never responds', async () => {
    // The homeserver being unreachable is a REASON to reach for this button, so it must
    // never be able to hold the wipe hostage.
    vi.useFakeTimers();
    const { svc, wipe } = setup({
      // NEVER, not a bare hanging Promise: firstValueFrom rejects on a non-Observable, so a
      // Promise here would be swallowed instantly and the budget never exercised at all.
      signOutAll: () => NEVER as never,
    });

    const done = firstValueFrom(svc.clearAllData());
    await vi.advanceTimersByTimeAsync(3_000);
    await done;

    expect(wipe.wipeKeyValueStores).toHaveBeenCalled();
  });

  it('completes the wipe when the sign-out rejects, without an unhandled rejection', async () => {
    // Each attempt is caught on its own, not by the race — the loser keeps running after
    // the race is decided, and a rejection escaping then would be reported globally and
    // surface an error toast in the middle of a deliberate wipe.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { svc, wipe } = setup({
        signOutAll: () =>
          throwError(() => new Error('homeserver down')) as never,
      });

      await firstValueFrom(svc.clearAllData());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(wipe.wipeKeyValueStores).toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('wipes a signed-out install with an empty registry', async () => {
    // The common wedged case: cannot sign in, so there is no account to read.
    const { svc, wipe, oidc } = setup({ records: [] });

    const report = await firstValueFrom(svc.clearAllData());

    expect(oidc.revokeTokens).not.toHaveBeenCalled();
    expect(wipe.wipeKeyValueStores).toHaveBeenCalled();
    expect(report.blocked).toEqual([]);
  });

  it('survives a registry read that fails, rather than refusing to wipe', async () => {
    // A corrupt registry is itself a reason to reset; failing here would make the button
    // useless in exactly that case.
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        FactoryResetService,
        MockProvider(SessionStorageService, {
          list: vi.fn(() => throwError(() => new Error('corrupt'))) as never,
        }),
        MockProvider(MatrixClientService, {
          stop: vi.fn(() => of(undefined)),
          signOutAll: vi.fn(() => of(undefined)),
        }),
        MockProvider(LocalDataWipeService, {
          wipeIndexedDb: vi.fn(async () => CLEAN_IDB),
          wipeKeyValueStores: vi.fn(async () => false),
          wipeServiceWorker: vi.fn(async () => undefined),
        }),
        MockProvider(OidcClientService),
      ],
    });
    const svc = TestBed.inject(FactoryResetService);
    const wipe = TestBed.inject(LocalDataWipeService);

    await expect(firstValueFrom(svc.clearAllData())).resolves.toMatchObject({
      blocked: [],
    });
    expect(wipe.wipeKeyValueStores).toHaveBeenCalled();
  });
});
