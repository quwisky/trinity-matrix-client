import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { Subject, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type EngineResult, engineFail, engineOk } from '@trinity/util/matrix';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import type { TrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { TrustHealthService } from './trust-health.service';

const BOB = '@bob:contract.invalid';

const READY: TrustFacts = {
  crossSigningReady: true,
  secretStorageReady: true,
  keyBackupActive: true,
  hasDefaultKey: true,
  thisDeviceCrossSigned: true,
  crossSigning: {
    publicKeysOnDevice: true,
    privateKeysInSecretStorage: true,
    privateKeysCachedLocally: {
      masterKey: true,
      selfSigningKey: true,
      userSigningKey: true,
    },
  },
};

function sessionWith(active: string | null, accounts: readonly string[]) {
  return {
    activeAccountId: active,
    accounts: accounts.map((accountId) => ({
      accountId,
      deviceId: 'DEVICE',
      generation: 1,
      syncState: 'syncing' as const,
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  } satisfies SessionSnapshot;
}

function setup(active?: string) {
  const engine = new FakeTrustEngine();
  const facts = vi.spyOn(engine, 'facts');
  const session = signal(sessionWith(active ?? engine.alice, [engine.alice]));
  TestBed.configureTestingModule({
    providers: [
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const service = TestBed.inject(TrustHealthService);
  return { service, engine, facts, session, alice: engine.alice };
}

function run(service: TrustHealthService) {
  const lifetime = service.runProjection().subscribe();
  TestBed.tick();
  return lifetime;
}

/** Lets a queued reconcile run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

const projection = () =>
  firstValueFrom(
    TestBed.inject(ProjectionRuntime).observe('trust.health', {
      kind: 'active-account',
    }),
  );

describe('TrustHealthService', () => {
  it("publishes the active account's status and follows its changes", async () => {
    const { service, engine, alice } = setup();
    run(service);

    expect(service.health().availability).toBe('coherent');
    expect(service.status()).toBe('needs-setup');

    engine.setFacts(alice, {
      crossSigningReady: true,
      secretStorageReady: true,
    });
    await settle();

    expect(service.status()).toBe('ready');
  });

  it('keeps the last snapshot as stale when a read fails, and reads again on retry', async () => {
    const { service, engine, facts, alice } = setup();
    run(service);

    engine.failRead(alice);
    await settle();

    expect(service.health()).toMatchObject({
      availability: 'stale',
      stale: { status: 'needs-setup' },
    });
    expect((await projection()).condition).toBe('failed');

    const reads = facts.mock.calls.length;
    service.retryProjection();
    await settle();

    expect(facts.mock.calls.length).toBe(reads + 1);
    expect(service.health()).toMatchObject({
      availability: 'coherent',
      current: { status: 'needs-setup' },
    });
    expect((await projection()).condition).toBe('available');
  });

  it('reads an account without crypto as unavailable, without failing a refresh', async () => {
    const { service, engine } = setup(BOB);
    engine.addAccount(BOB, { crypto: false });

    await firstValueFrom(service.refresh(), { defaultValue: undefined });

    expect(service.health().availability).toBe('unavailable');
  });

  it('surfaces a refresh whose read fails', async () => {
    const { service, facts } = setup();
    const read = new Subject<EngineResult<TrustFacts>>();
    facts.mockReturnValueOnce(read);
    const refreshed = firstValueFrom(service.refresh());
    read.next(
      engineFail({
        kind: 'unexpected',
        code: 'request-failed',
        diagnostic: { kind: 'unexpected' },
      }),
    );

    await expect(refreshed).rejects.toMatchObject({ kind: 'server-failure' });
    expect(service.health().availability).toBe('unavailable');
  });

  it('keeps the reset state when a refresh finishes after reset', async () => {
    const { service, facts, session } = setup();
    run(service);
    const read = new Subject<EngineResult<TrustFacts>>();
    facts.mockReturnValueOnce(read);
    const refreshed = firstValueFrom(service.refresh(), {
      defaultValue: undefined,
    });

    session.set(sessionWith(null, []));
    TestBed.tick();
    read.next(engineOk(READY));
    await refreshed;

    expect(service.health().availability).toBe('unavailable');
    expect(service.status()).toBe('unknown');
  });
});
