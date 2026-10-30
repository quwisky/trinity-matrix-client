import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import type { TrustHealthSnapshot } from './trust-health.service';
import { TRUST_ENGINE } from './trust-engine.token';
import {
  TrustAccountStatusService,
  summarizeTrust,
} from './trust-account-status.service';

const A = '@a:hs';
const B = '@b:hs';
const C = '@c:hs';

function sessionWith(
  accounts: readonly string[],
  generation = 1,
): SessionSnapshot {
  return {
    activeAccountId: accounts[0] ?? null,
    accounts: accounts.map((accountId) => ({
      accountId,
      deviceId: 'DEVICE',
      generation,
      syncState: 'syncing',
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  };
}

/** An account whose device is verified, unverified with recovery, or without any identity. */
function addAccount(
  engine: FakeTrustEngine,
  accountId: string,
  state: 'verified' | 'unverified' | 'not-set-up' | 'no-crypto',
): void {
  engine.addAccount(accountId, { crypto: state !== 'no-crypto' });
  if (state === 'verified') {
    engine.setFacts(accountId, { thisDeviceCrossSigned: true });
  } else if (state === 'unverified') {
    engine.setFacts(accountId, { hasDefaultKey: true });
  }
}

function setup(accounts: Record<string, Parameters<typeof addAccount>[2]>) {
  const engine = new FakeTrustEngine();
  for (const [id, state] of Object.entries(accounts)) {
    addAccount(engine, id, state);
  }
  const facts = vi.spyOn(engine, 'facts');
  const session = signal(sessionWith(Object.keys(accounts)));
  TestBed.configureTestingModule({
    providers: [
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const service = TestBed.inject(TrustAccountStatusService);
  const subscription = service.run().subscribe();
  TestBed.tick();
  return { service, engine, facts, session, subscription };
}

afterEach(() => TestBed.resetTestingModule());

describe('TrustAccountStatusService', () => {
  it('summarises every live account, not only the active one', () => {
    const { service, subscription } = setup({
      [A]: 'verified',
      [B]: 'unverified',
      [C]: 'not-set-up',
    });

    expect(service.summaries()).toEqual(
      new Map([
        [A, 'verified'],
        [B, 'unverified'],
        [C, 'not-set-up'],
      ]),
    );
    subscription.unsubscribe();
  });

  it('recomputes an account when its facts change', () => {
    const { service, engine, subscription } = setup({ [B]: 'unverified' });
    expect(service.summaries().get(B)).toBe('unverified');

    engine.setFacts(B, { thisDeviceCrossSigned: true });

    expect(service.summaries().get(B)).toBe('verified');
    subscription.unsubscribe();
  });

  it('summarises an account added to a running list and keeps the others', () => {
    const { service, engine, session, subscription } = setup({
      [A]: 'verified',
    });
    expect(service.summaries()).toEqual(new Map([[A, 'verified']]));

    addAccount(engine, B, 'unverified');
    session.set(sessionWith([A, B]));
    TestBed.tick();

    expect(service.summaries()).toEqual(
      new Map([
        [A, 'verified'],
        [B, 'unverified'],
      ]),
    );
    subscription.unsubscribe();
  });

  it('forgets an account that signs out and releases its subscription', () => {
    const { service, engine, session, subscription } = setup({
      [A]: 'not-set-up',
      [B]: 'unverified',
    });
    expect(service.summaries().size).toBe(2);

    session.set(sessionWith([A]));
    TestBed.tick();

    expect([...service.summaries().keys()]).toEqual([A]);
    expect(engine.watched(B)).toBe(false);
    subscription.unsubscribe();
  });

  // The session replaces a client under the same id with a new generation (#1233).
  it('subscribes again when an account gets a new client', () => {
    const { service, engine, facts, session, subscription } = setup({
      [B]: 'unverified',
    });
    const reads = facts.mock.calls.filter(([id]) => id === B).length;

    session.set(sessionWith([B], 2));
    TestBed.tick();

    expect(facts.mock.calls.filter(([id]) => id === B).length).toBe(reads + 1);
    engine.setFacts(B, { thisDeviceCrossSigned: true });
    expect(service.summaries().get(B)).toBe('verified');
    subscription.unsubscribe();
  });

  it('reports unknown while an account has no crypto yet, or its read fails', () => {
    const { service, engine, subscription } = setup({
      [A]: 'no-crypto',
      [B]: 'unverified',
    });
    engine.failRead(B);

    expect(service.summaries()).toEqual(
      new Map([
        [A, 'unknown'],
        [B, 'unknown'],
      ]),
    );
    subscription.unsubscribe();
  });

  it('releases every subscription and forgets every account when the session ends', () => {
    const { service, engine, subscription } = setup({ [A]: 'verified' });
    expect(service.summaries().size).toBe(1);

    subscription.unsubscribe();

    expect(service.summaries().size).toBe(0);
    expect(engine.watched(A)).toBe(false);
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
