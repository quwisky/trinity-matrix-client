// Shared TestBed scaffolding for the identity service specs: a FakeIdentityEngine behind
// IDENTITY_ENGINE and a writable session snapshot behind SESSION_SNAPSHOT.
import { type Provider, signal } from '@angular/core';
import {
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import type { EngineFailure } from '@trinity/util/matrix';
import { FakeIdentityEngine } from '../contract/fake-identity-engine';
import { IDENTITY_ENGINE } from './identity-engine.token';

export const ME = '@me:hs';

export const OFFLINE: EngineFailure = {
  kind: 'network',
  code: 'request-failed',
  diagnostic: { kind: 'network', errorName: 'ConnectionError' },
};

export const SERVER_ERROR: EngineFailure = {
  kind: 'server',
  code: 'request-failed',
  diagnostic: { kind: 'server', httpStatus: 500 },
};

/** A session where `accounts` are live, each in session `generation`, and `active` is active. */
export function sessionWith(
  active: string | null,
  accounts: readonly string[],
  generation = 1,
): SessionSnapshot {
  return {
    activeAccountId: active,
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

/** The engine and session for `accounts`, the first active and each signed in to the engine. */
export function identityFixture(accounts: readonly string[] = [ME]) {
  const engine = new FakeIdentityEngine();
  for (const accountId of accounts) engine.signIn(accountId);
  const session = signal(sessionWith(accounts[0] ?? null, accounts));
  const providers: Provider[] = [
    { provide: IDENTITY_ENGINE, useValue: engine },
    { provide: SESSION_SNAPSHOT, useValue: session },
  ];
  return { engine, session, providers };
}
