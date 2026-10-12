import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TrustCryptoPort,
  type ActiveTrustCrypto,
} from '@trinity/data-access/matrix-client';
import type { TrustHealthSnapshot } from './trust-health.service';
import {
  TrustAccountStatusService,
  summarizeTrust,
} from './trust-account-status.service';

interface AccountState {
  defaultKeyId: string | null;
  verified: boolean;
}

function fakeAccount(state: AccountState, withCrypto = true) {
  const listeners = new Map<string, Set<() => void>>();
  const crypto = {
    isCrossSigningReady: vi.fn(async () => state.verified),
    isSecretStorageReady: vi.fn(async () => state.defaultKeyId !== null),
    getActiveSessionBackupVersion: vi.fn(async () => null),
    getDeviceVerificationStatus: vi.fn(async () => ({
      crossSigningVerified: state.verified,
    })),
    getCrossSigningStatus: vi.fn(async () => ({
      publicKeysOnDevice: false,
      privateKeysInSecretStorage: false,
      privateKeysCachedLocally: {
        masterKey: false,
        selfSigningKey: false,
        userSigningKey: false,
      },
    })),
  };
  const client = {
    getDeviceId: () => 'DEVICE',
    getUserId: () => '@me:hs',
    secretStorage: { getDefaultKeyId: vi.fn(async () => state.defaultKeyId) },
    on: vi.fn((event: string, fn: () => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    }),
    off: vi.fn((event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn);
    }),
  };
  const context: ActiveTrustCrypto = {
    client: client as never,
    crypto: withCrypto ? (crypto as never) : null,
  };
  return {
    context,
    state,
    crypto,
    emit: (event: string) => {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

type FakeAccount = ReturnType<typeof fakeAccount>;

function setup(accounts: Record<string, FakeAccount>) {
  const liveAccountIds = signal<readonly string[]>(Object.keys(accounts));
  TestBed.configureTestingModule({
    providers: [
      TrustAccountStatusService,
      MockProvider(TrustCryptoPort, {
        liveAccountIds: liveAccountIds.asReadonly(),
        forAccount: (id: string) => accounts[id]?.context ?? null,
      }),
    ],
  });
  const service = TestBed.inject(TrustAccountStatusService);
  const subscription = service.run().subscribe();
  TestBed.tick();
  return { service, liveAccountIds, subscription };
}

afterEach(() => TestBed.resetTestingModule());

describe('TrustAccountStatusService', () => {
  it('summarises every live account, not only the active one', async () => {
    const { service, subscription } = setup({
      '@a:hs': fakeAccount({ defaultKeyId: 'k', verified: true }),
      '@b:hs': fakeAccount({ defaultKeyId: 'k', verified: false }),
      '@c:hs': fakeAccount({ defaultKeyId: null, verified: false }),
    });

    await vi.waitFor(() =>
      expect(service.summaries()).toEqual(
        new Map([
          ['@a:hs', 'verified'],
          ['@b:hs', 'unverified'],
          ['@c:hs', 'not-set-up'],
        ]),
      ),
    );
    subscription.unsubscribe();
  });

  it('recomputes an account when its crypto state changes', async () => {
    const b = fakeAccount({ defaultKeyId: 'k', verified: false });
    const { service, subscription } = setup({ '@b:hs': b });
    await vi.waitFor(() =>
      expect(service.summaries().get('@b:hs')).toBe('unverified'),
    );

    b.state.verified = true;
    b.emit(CryptoEvent.UserTrustStatusChanged);

    await vi.waitFor(() =>
      expect(service.summaries().get('@b:hs')).toBe('verified'),
    );
    subscription.unsubscribe();
  });

  it('keeps the newest read when an older one resolves later', async () => {
    const b = fakeAccount({ defaultKeyId: 'k', verified: false });
    let releaseFirst!: () => void;
    b.crypto.getDeviceVerificationStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ crossSigningVerified: false });
        }),
    );
    const { service, subscription } = setup({ '@b:hs': b });
    // The first read is now waiting on its last answer, with an unverified view.
    await vi.waitFor(() =>
      expect(b.crypto.getDeviceVerificationStatus).toHaveBeenCalledOnce(),
    );

    b.state.verified = true;
    b.emit(CryptoEvent.UserTrustStatusChanged);
    await vi.waitFor(() =>
      expect(service.summaries().get('@b:hs')).toBe('verified'),
    );

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(service.summaries().get('@b:hs')).toBe('verified');
    subscription.unsubscribe();
  });

  it('forgets an account that signs out and releases its listeners', async () => {
    const b = fakeAccount({ defaultKeyId: 'k', verified: false });
    const { service, liveAccountIds, subscription } = setup({
      '@a:hs': fakeAccount({ defaultKeyId: null, verified: false }),
      '@b:hs': b,
    });
    await vi.waitFor(() => expect(service.summaries().size).toBe(2));

    liveAccountIds.set(['@a:hs']);
    TestBed.tick();

    await vi.waitFor(() =>
      expect([...service.summaries().keys()]).toEqual(['@a:hs']),
    );
    expect(b.listenerCount()).toBe(0);
    subscription.unsubscribe();
  });

  it('re-reads an account whose client is replaced', async () => {
    const before = fakeAccount({ defaultKeyId: 'k', verified: false });
    const accounts: Record<string, FakeAccount> = { '@b:hs': before };
    const { service, liveAccountIds, subscription } = setup(accounts);
    await vi.waitFor(() =>
      expect(service.summaries().get('@b:hs')).toBe('unverified'),
    );

    accounts['@b:hs'] = fakeAccount({ defaultKeyId: 'k', verified: true });
    // Matrix Runtime publishes a new array when it replaces a client (#1233).
    liveAccountIds.set(['@b:hs']);
    TestBed.tick();

    await vi.waitFor(() =>
      expect(service.summaries().get('@b:hs')).toBe('verified'),
    );
    expect(before.listenerCount()).toBe(0);
    subscription.unsubscribe();
  });

  it('reports unknown while an account has no crypto yet, or its read fails', async () => {
    const failing = fakeAccount({ defaultKeyId: 'k', verified: false });
    failing.crypto.isCrossSigningReady.mockRejectedValue(new Error('locked'));
    const { service, subscription } = setup({
      '@a:hs': fakeAccount({ defaultKeyId: null, verified: false }, false),
      '@b:hs': failing,
    });

    await vi.waitFor(() =>
      expect(service.summaries()).toEqual(
        new Map([
          ['@a:hs', 'unknown'],
          ['@b:hs', 'unknown'],
        ]),
      ),
    );
    subscription.unsubscribe();
  });

  it('releases every listener and forgets every account when the session ends', async () => {
    const a = fakeAccount({ defaultKeyId: 'k', verified: true });
    const { service, subscription } = setup({ '@a:hs': a });
    await vi.waitFor(() => expect(service.summaries().size).toBe(1));

    subscription.unsubscribe();

    expect(service.summaries().size).toBe(0);
    expect(a.listenerCount()).toBe(0);
  });
});

describe('summarizeTrust', () => {
  const snapshot = (
    over: Partial<TrustHealthSnapshot>,
  ): TrustHealthSnapshot => ({
    status: 'needs-setup',
    keyBackupActive: false,
    thisDeviceVerified: false,
    identityElsewhere: false,
    ...over,
  });

  it.each([
    [null, 'unknown'],
    [snapshot({ status: 'ready', thisDeviceVerified: true }), 'verified'],
    [
      snapshot({ status: 'needs-recovery', thisDeviceVerified: true }),
      'verified',
    ],
    // Verified through another device on an account without recovery (#1214's N4 state).
    [
      snapshot({
        status: 'needs-setup',
        thisDeviceVerified: true,
        identityElsewhere: true,
      }),
      'verified',
    ],
    [snapshot({ status: 'needs-recovery' }), 'unverified'],
    [
      snapshot({ status: 'needs-verification', identityElsewhere: true }),
      'unverified',
    ],
    [snapshot({ status: 'needs-setup' }), 'not-set-up'],
  ] as const)('maps %o to %s', (input, summary) => {
    expect(summarizeTrust(input)).toBe(summary);
  });
});
