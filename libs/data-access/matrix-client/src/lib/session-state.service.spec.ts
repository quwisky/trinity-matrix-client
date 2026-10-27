import { TestBed } from '@angular/core/testing';
import { effect } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MatrixSession } from '@trinity/util/matrix';
import { FakeSessionEngine } from '../contract/fake-session-engine';
import { SESSION_SNAPSHOT } from './session-engine.token';
import {
  SessionStateService,
  sessionSnapshotFrom,
} from './session-state.service';

const A: MatrixSession = {
  baseUrl: 'https://hs.example',
  userId: '@a:hs',
  deviceId: 'A',
  accessToken: 'ta',
};
const B: MatrixSession = { ...A, userId: '@b:hs', deviceId: 'B' };

describe('SessionStateService', () => {
  let fake: FakeSessionEngine;
  let state: SessionStateService;

  const add = (session: MatrixSession, activation: 'activate' | 'background') =>
    firstValueFrom(fake.restorePersisted(session, activation));

  beforeEach(() => {
    fake = new FakeSessionEngine();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SESSION_SNAPSHOT,
          useFactory: () => sessionSnapshotFrom(fake),
        },
      ],
    });
    state = TestBed.inject(SessionStateService);
  });

  it('is empty with no account', () => {
    expect(state.activeAccountId()).toBeNull();
    expect(state.accountIds()).toEqual([]);
    expect(state.softLoggedOut()).toEqual([]);
    expect(state.active()).toBeNull();
    expect(state.syncState()).toBeNull();
    expect(state.connectivity()).toBe('online');
    expect(state.waitingCount()).toBe(0);
    expect(state.cryptoStoreEncrypted()).toBeNull();
    expect(state.status(A.userId)).toBeNull();
  });

  it('derives from one active account and a soft-logged-out id', async () => {
    await add(A, 'activate');
    fake.failStart(B.userId, 'reauthentication-required');
    await add(B, 'background');

    expect(state.activeAccountId()).toBe(A.userId);
    expect(state.accountIds()).toEqual([A.userId]);
    expect(state.softLoggedOut()).toEqual([B.userId]);
    expect(state.status(A.userId)).toMatchObject({ serverSynced: true });
    expect(state.status(B.userId)).toBeNull();
  });

  it('follows the active account for connectivity and counts', async () => {
    await add(A, 'activate');
    await add(B, 'background');
    fake.sync(A.userId, { waitingCount: 2, cryptoStoreEncrypted: false });
    fake.sync(B.userId, { syncState: 'error', waitingCount: 5 });

    expect(state.syncState()).toBe('syncing');
    expect(state.connectivity()).toBe('online');
    expect(state.waitingCount()).toBe(2);
    expect(state.cryptoStoreEncrypted()).toBe(false);

    await firstValueFrom(fake.setActive(B.userId));
    expect(state.syncState()).toBe('error');
    expect(state.connectivity()).toBe('offline');
    expect(state.waitingCount()).toBe(5);
  });

  it('does not re-run accountIds readers on a status change', async () => {
    await add(A, 'activate');
    let runs = 0;
    TestBed.runInInjectionContext(() =>
      effect(() => {
        state.accountIds();
        state.softLoggedOut();
        runs += 1;
      }),
    );
    TestBed.tick();
    expect(runs).toBe(1);

    for (const waitingCount of [1, 2, 3]) {
      fake.sync(A.userId, { waitingCount });
      TestBed.tick();
    }
    fake.sync(A.userId, { syncState: 'reconnecting' });
    TestBed.tick();

    expect(runs).toBe(1);
  });

  it('keeps status(id) stable while only another account changes', async () => {
    await add(A, 'activate');
    await add(B, 'background');
    const before = state.status(A.userId);

    fake.sync(B.userId, { waitingCount: 1 });

    expect(state.status(A.userId)).toBe(before);
  });
});
