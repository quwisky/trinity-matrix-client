import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustOperationError } from './trust-operation-error';
import { TrustUsersService } from './trust-users.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

const ALICE = '@alice:hs';
const BOB = '@bob:hs';

interface Status {
  isCrossSigningVerified(): boolean;
  wasCrossSigningVerified(): boolean;
  readonly needsUserApproval: boolean;
}

const status = (is: boolean, was: boolean, approve = false): Status => ({
  isCrossSigningVerified: () => is,
  wasCrossSigningVerified: () => was,
  needsUserApproval: approve,
});

function fakeClient(
  read: (userId: string) => Promise<Status> = async () => status(false, false),
  crypto = true,
) {
  const getUserVerificationStatus = vi.fn(read);
  const pinCurrentUserIdentity = vi.fn(async (_userId: string) => undefined);
  const withdrawVerificationRequirement = vi.fn(
    async (_userId: string) => undefined,
  );
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getCrypto: vi.fn(() =>
      crypto
        ? {
            getUserVerificationStatus,
            pinCurrentUserIdentity,
            withdrawVerificationRequirement,
          }
        : undefined,
    ),
    getUserVerificationStatus,
    pinCurrentUserIdentity,
    withdrawVerificationRequirement,
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

  it('returns verified-identity-changed when a previously verified identity is no longer verified', async () => {
    const { svc } = setup(fakeClient(async () => status(false, true, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('verified-identity-changed');
    lifetime.unsubscribe();
  });

  it('returns identity-changed when an unverified identity needs approval', async () => {
    const { svc } = setup(fakeClient(async () => status(false, false, true)));
    const lifetime = svc.runProjection().subscribe();
    const trust = svc.userTrust(ALICE);
    await settle();
    expect(trust()).toBe('identity-changed');
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

  describe('identity actions', () => {
    it.each([
      ['acknowledgeIdentity', 'pinCurrentUserIdentity'],
      ['withdrawVerification', 'withdrawVerificationRequirement'],
    ] as const)(
      '%s calls %s and re-reads the user',
      async (action, sdkMethod) => {
        let next = status(false, true, true);
        const client = fakeClient(async () => next);
        const { svc } = setup(client);
        const lifetime = svc.runProjection().subscribe();
        const trust = svc.userTrust(ALICE);
        await settle();
        expect(trust()).toBe('verified-identity-changed');

        next = status(false, false);
        await firstValueFrom(svc[action](ALICE), { defaultValue: undefined });
        await settle();

        expect(client[sdkMethod]).toHaveBeenCalledWith(ALICE);
        expect(trust()).toBe('unverified');
        lifetime.unsubscribe();
      },
    );

    it('is cold: nothing runs until subscribed', () => {
      const client = fakeClient();
      const { svc } = setup(client);

      svc.acknowledgeIdentity(ALICE);

      expect(client.pinCurrentUserIdentity).not.toHaveBeenCalled();
    });

    it('reports a failure as a TrustOperationError', async () => {
      const client = fakeClient();
      client.withdrawVerificationRequirement.mockRejectedValue(
        new Error('no identity for @alice:hs'),
      );
      const { svc } = setup(client);

      const error = await firstValueFrom(svc.withdrawVerification(ALICE)).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TrustOperationError);
      expect((error as TrustOperationError).operation).toBe(
        'withdraw-verification',
      );
      expect((error as Error).message).not.toContain('@alice:hs');
    });
  });
});
