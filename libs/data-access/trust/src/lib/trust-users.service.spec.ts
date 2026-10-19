import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider, ngMocks } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustUsersService } from './trust-users.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

const ALICE = '@alice:hs';
const BOB = '@bob:hs';

interface Status {
  isCrossSigningVerified(): boolean;
  wasCrossSigningVerified(): boolean;
}

const status = (is: boolean, was: boolean): Status => ({
  isCrossSigningVerified: () => is,
  wasCrossSigningVerified: () => was,
});

function fakeClient(
  read: (userId: string) => Promise<Status> = async () => status(false, false),
  crypto = true,
) {
  const getUserVerificationStatus = vi.fn(read);
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getCrypto: vi.fn(() =>
      crypto ? { getUserVerificationStatus } : undefined,
    ),
    getUserVerificationStatus,
    on: vi.fn(),
    off: vi.fn(),
  };
}

const activeUserId = signal<string | null>(null);

function setup(client = fakeClient()) {
  activeUserId.set('@me:hs');
  TestBed.configureTestingModule({
    providers: [
      TrustUsersService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'instance', client as unknown as MatrixClient);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  return { svc: TestBed.inject(TrustUsersService), client, matrix };
}

/** The `UserTrustStatusChanged` handler the service bound on the client. */
function trustHandler(client: ReturnType<typeof fakeClient>) {
  return client.on.mock.calls.find(
    (c) => c[0] === CryptoEvent.UserTrustStatusChanged,
  )?.[1] as (userId: string, next: Status) => void;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('TrustUsersService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns verified when the user is cross-signing verified', async () => {
    const { svc } = setup(fakeClient(async () => status(true, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('verified');
    expect(svc.userTrust(ALICE)).toBe(trust);
    lifetime.unsubscribe();
  });

  it('returns changed when a previously verified identity is no longer verified', async () => {
    const { svc } = setup(fakeClient(async () => status(false, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('changed');
    lifetime.unsubscribe();
  });

  it('returns unverified for a user never verified', async () => {
    const { svc } = setup(fakeClient(async () => status(false, false)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');
    lifetime.unsubscribe();
  });

  it('returns unverified when the status read fails', async () => {
    const { svc } = setup(
      fakeClient(() => Promise.reject(new Error('store closed'))),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');
    lifetime.unsubscribe();
  });

  it('refreshes on UserTrustStatusChanged for that user only', async () => {
    const { svc, client } = setup(fakeClient(async () => status(false, false)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('unverified');

    trustHandler(client)(BOB, status(true, true));
    await settle();
    expect(trust()).toBe('unverified');

    trustHandler(client)(ALICE, status(true, true));
    await settle();
    expect(trust()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('discards a slower earlier read once a newer status has arrived', async () => {
    let resolveFirst: (s: Status) => void = () => undefined;
    const { svc, client } = setup(
      fakeClient(
        () => new Promise<Status>((resolve) => (resolveFirst = resolve)),
      ),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);

    trustHandler(client)(ALICE, status(true, true));
    resolveFirst(status(false, false));
    await settle();
    expect(trust()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('is null while crypto is unavailable and after an account switch', async () => {
    const { svc, matrix } = setup(
      fakeClient(async () => status(true, true), false),
    );
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBeNull();

    const clientA = fakeClient(async () => status(true, true));
    ngMocks.stubMember(matrix, 'instance', clientA as unknown as MatrixClient);
    activeUserId.set('@a:hs');
    TestBed.inject(ApplicationRef).tick();
    await settle();
    expect(trust()).toBe('verified');

    const clientB = fakeClient(() => new Promise<Status>(() => undefined));
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();
    await settle();
    expect(trust()).toBeNull();

    lifetime.unsubscribe();
  });

  it('is null when no projection is running', async () => {
    const { svc } = setup(fakeClient(async () => status(true, true)));
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBeNull();
  });
});
