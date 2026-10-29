import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { Subject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type EngineResult, engineOk } from '@trinity/util/matrix';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import type { UserTrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { TrustOperationError } from './trust-operation-error';
import { TrustUsersService } from './trust-users.service';

const ALICE = '@alice:hs';
const BOB = '@bob:hs';
const ME2 = '@me2:contract.invalid';

function sessionWith(active: string | null, accounts: readonly string[]) {
  return {
    activeAccountId: active,
    accounts: accounts.map((accountId) => ({
      accountId,
      deviceId: 'FAKEDEVICE',
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

function setup() {
  const engine = new FakeTrustEngine();
  const me = engine.alice;
  engine.addAccount(ME2);
  const session = signal(sessionWith(me, [me, ME2]));
  TestBed.configureTestingModule({
    providers: [
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const svc = TestBed.inject(TrustUsersService);
  return { svc, engine, me, session };
}

function run(svc: TrustUsersService) {
  const lifetime = svc.runProjection().subscribe();
  TestBed.tick();
  return lifetime;
}

/** Lets a queued reconcile run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

describe('TrustUsersService', () => {
  it.each([
    ['verified', { verified: true, wasVerified: true }],
    ['verified-identity-changed', { wasVerified: true, needsApproval: true }],
    ['identity-changed', { needsApproval: true }],
    ['unverified', {}],
  ] as const)('reads %s', async (expected, trust) => {
    const { svc, engine, me } = setup();
    engine.setUserTrust(me, ALICE, trust);
    const lifetime = run(svc);

    const state = svc.userTrust(ALICE);
    await settle();

    expect(state()).toBe(expected);
    expect(svc.userTrust(ALICE)).toBe(state);
    lifetime.unsubscribe();
  });

  it('follows changes for that user only', async () => {
    const { svc, engine, me } = setup();
    const lifetime = run(svc);
    const alice = svc.userTrust(ALICE);
    const bob = svc.userTrust(BOB);
    await settle();
    expect(alice()).toBe('unverified');

    engine.setUserTrust(me, BOB, { verified: true });
    await settle();
    expect(alice()).toBe('unverified');
    expect(bob()).toBe('verified');

    engine.setUserTrust(me, ALICE, { verified: true });
    await settle();
    expect(alice()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('reads users asked about before the projection started', async () => {
    const { svc, engine, me } = setup();
    engine.setUserTrust(me, ALICE, { verified: true });
    const state = svc.userTrust(ALICE);
    expect(state()).toBeNull();

    const lifetime = run(svc);
    await settle();

    expect(state()).toBe('verified');
    lifetime.unsubscribe();
  });

  it('is null while crypto is unavailable', async () => {
    const { svc, engine, session } = setup();
    engine.addAccount('@carol:contract.invalid', { crypto: false });
    session.set(
      sessionWith('@carol:contract.invalid', ['@carol:contract.invalid']),
    );
    const lifetime = run(svc);
    const state = svc.userTrust(ALICE);
    await settle();

    expect(state()).toBeNull();
    lifetime.unsubscribe();
  });

  it('follows the newly active account on a switch, null until it reads', async () => {
    const { svc, engine, me, session } = setup();
    engine.setUserTrust(me, ALICE, { verified: true });
    const lifetime = run(svc);
    const state = svc.userTrust(ALICE);
    await settle();
    expect(state()).toBe('verified');
    const read = new Subject<EngineResult<UserTrustFacts>>();
    vi.spyOn(engine, 'userTrust').mockReturnValue(read);

    session.set(sessionWith(ME2, [me, ME2]));
    TestBed.tick();
    await settle();
    expect(state()).toBeNull();
    expect(engine.userTrust).toHaveBeenCalledWith(ME2, ALICE);

    read.next(
      engineOk({ verified: false, wasVerified: false, needsApproval: false }),
    );
    await settle();
    expect(state()).toBe('unverified');
    lifetime.unsubscribe();
  });

  it('releases every user subscription when the projection stops', async () => {
    const { svc, engine, me } = setup();
    const lifetime = run(svc);
    const state = svc.userTrust(ALICE);
    svc.userTrust(BOB);
    await settle();
    expect(engine.userSubscriptions(me)).toBe(2);

    lifetime.unsubscribe();

    expect(engine.userSubscriptions(me)).toBe(0);
    expect(state()).toBeNull();
  });

  it('is null when no projection is running', async () => {
    const { svc, engine, me } = setup();
    engine.setUserTrust(me, ALICE, { verified: true });

    const state = svc.userTrust(ALICE);
    await settle();

    expect(state()).toBeNull();
  });

  describe('identity actions', () => {
    it.each([
      ['acknowledgeIdentity', 'pinIdentity', { needsApproval: true }],
      ['withdrawVerification', 'withdrawVerification', { wasVerified: true }],
    ] as const)(
      '%s calls %s and the user reads unverified before it completes',
      async (action, engineMethod, before) => {
        const { svc, engine, me } = setup();
        engine.setUserTrust(me, ALICE, before);
        const call = vi.spyOn(engine, engineMethod);
        const lifetime = run(svc);
        const state = svc.userTrust(ALICE);
        await settle();
        expect(state()).not.toBe('unverified');

        await firstValueFrom(svc[action](ALICE), { defaultValue: undefined });

        expect(call).toHaveBeenCalledWith(me, ALICE);
        expect(state()).toBe('unverified');
        lifetime.unsubscribe();
      },
    );

    it('keeps the newest status when the projection publishes after the re-read', async () => {
      const { svc, engine, me } = setup();
      engine.setUserTrust(me, ALICE, { needsApproval: true });
      const lifetime = run(svc);
      const state = svc.userTrust(ALICE);
      await settle();

      await firstValueFrom(svc.acknowledgeIdentity(ALICE), {
        defaultValue: undefined,
      });
      engine.setUserTrust(me, BOB, { verified: true }); // another user's change
      svc.userTrust(BOB);
      await settle();

      expect(state()).toBe('unverified');
      lifetime.unsubscribe();
    });

    it('is cold: nothing runs until subscribed', () => {
      const { svc, engine } = setup();
      const pin = vi.spyOn(engine, 'pinIdentity');

      svc.acknowledgeIdentity(ALICE);

      expect(pin).not.toHaveBeenCalled();
    });

    it('reports an account without crypto as not ready', async () => {
      const { svc, engine, session } = setup();
      engine.addAccount('@carol:contract.invalid', { crypto: false });
      session.set(
        sessionWith('@carol:contract.invalid', ['@carol:contract.invalid']),
      );

      await expect(
        firstValueFrom(svc.acknowledgeIdentity(ALICE)),
      ).rejects.toMatchObject({
        operation: 'acknowledge-identity',
        kind: 'not-ready',
        recovery: 'retry',
      });
    });

    it('reports a failure as a TrustOperationError without the user id', async () => {
      const { svc } = setup(); // ALICE's identity was never seen: the engine refuses

      const error = await firstValueFrom(svc.withdrawVerification(ALICE)).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TrustOperationError);
      expect((error as TrustOperationError).operation).toBe(
        'withdraw-verification',
      );
      expect((error as Error).message).not.toContain(ALICE);
    });

    it('waits for the re-read before completing', async () => {
      const { svc, engine, me } = setup();
      engine.setUserTrust(me, ALICE, { needsApproval: true });
      const lifetime = run(svc);
      svc.userTrust(ALICE);
      await settle();
      const reread = new Subject<EngineResult<UserTrustFacts>>();
      vi.spyOn(engine, 'pinIdentity').mockReturnValue(of(engineOk(null)));
      vi.spyOn(engine, 'userTrust').mockReturnValue(reread);
      let completed = false;

      svc.acknowledgeIdentity(ALICE).subscribe({
        complete: () => (completed = true),
      });
      expect(completed).toBe(false);
      reread.next(
        engineOk({ verified: false, wasVerified: false, needsApproval: false }),
      );

      expect(completed).toBe(true);
      lifetime.unsubscribe();
    });
  });
});
