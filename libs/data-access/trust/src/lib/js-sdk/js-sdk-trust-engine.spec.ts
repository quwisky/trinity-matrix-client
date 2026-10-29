import { TestBed } from '@angular/core/testing';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { EngineResult } from '@trinity/util/matrix';
import type { TrustFacts } from '../trust-engine';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';

const ME = '@me:hs';

function setup({ withCrypto = true } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const state = { verified: false };
  const crypto = {
    userHasCrossSigningKeys: vi.fn(async () => true),
    isCrossSigningReady: vi.fn(async () => state.verified),
    isSecretStorageReady: vi.fn(async () => false),
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
    getCrypto: () => (withCrypto ? crypto : undefined),
    getDeviceId: () => 'DEVICE',
    getUserId: () => ME,
    secretStorage: { getDefaultKeyId: vi.fn(async () => null) },
    http: { authedRequest: vi.fn() },
    downloadKeysForUsers: vi.fn(async (userIds: string[]) => ({
      master_keys: {
        [userIds[0]]: { keys: { 'ed25519:MASTER': 'MASTER' } },
      },
    })),
    on: vi.fn((event: string, fn: () => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    }),
    off: vi.fn((event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn);
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => (id === ME ? client : null) },
      },
    ],
  });
  const results: EngineResult<TrustFacts>[] = [];
  const watch = () =>
    TestBed.inject(JsSdkTrustEngine)
      .facts(ME)
      .subscribe((result) => results.push(result));
  return {
    engine: TestBed.inject(JsSdkTrustEngine),
    client,
    crypto,
    state,
    results,
    watch,
    emit: (event: string) => {
      for (const fn of listeners.get(event) ?? []) fn();
    },
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('JsSdkTrustEngine', () => {
  describe('facts', () => {
    it('reads once for a burst of crypto events', async () => {
      const { crypto, watch, emit, results } = setup();
      const subscription = watch();
      await vi.waitFor(() => expect(results).toHaveLength(1));

      for (let event = 0; event < 5; event++) {
        emit(CryptoEvent.UserTrustStatusChanged);
      }

      await vi.waitFor(() =>
        expect(crypto.isCrossSigningReady).toHaveBeenCalledTimes(2),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(crypto.isCrossSigningReady).toHaveBeenCalledTimes(2);
      subscription.unsubscribe();
    });

    it('keeps the newest read when an older one resolves later', async () => {
      const { crypto, state, watch, emit, results } = setup();
      let releaseFirst!: () => void;
      crypto.getDeviceVerificationStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ crossSigningVerified: false });
          }),
      );
      const subscription = watch();
      await vi.waitFor(() =>
        expect(crypto.getDeviceVerificationStatus).toHaveBeenCalledOnce(),
      );

      state.verified = true;
      emit(CryptoEvent.UserTrustStatusChanged);
      await vi.waitFor(() => expect(results).toHaveLength(1));
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        ok: true,
        value: { thisDeviceCrossSigned: true },
      });
      subscription.unsubscribe();
    });

    it('reports a failed read as a value and reads again on the next change', async () => {
      const { crypto, watch, emit, results } = setup();
      crypto.isCrossSigningReady.mockRejectedValueOnce(new Error('locked'));
      const subscription = watch();
      await vi.waitFor(() => expect(results).toHaveLength(1));
      expect(results[0]).toMatchObject({
        ok: false,
        failure: { code: 'request-failed' },
      });

      emit(CryptoEvent.KeysChanged);

      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(results[1].ok).toBe(true);
      subscription.unsubscribe();
    });

    it('fails with crypto-not-ready for a live account without crypto', () => {
      const { watch, results } = setup({ withCrypto: false });
      watch().unsubscribe();

      expect(results).toMatchObject([
        { ok: false, failure: { code: 'crypto-not-ready' } },
      ]);
    });

    it('releases its listeners on unsubscribe', () => {
      const { client, watch } = setup();
      watch().unsubscribe();

      expect(client.off).toHaveBeenCalledTimes(client.on.mock.calls.length);
    });
  });

  describe('publishedMasterKey', () => {
    // Device confirmation's server question: the old single /keys/query, nothing more.
    it('asks the server once, without the forced identity re-query', async () => {
      const { engine, client, crypto } = setup();

      expect(await firstValueFrom(engine.publishedMasterKey(ME))).toEqual({
        ok: true,
        value: 'MASTER',
      });
      expect(client.downloadKeysForUsers).toHaveBeenCalledOnce();
      expect(client.downloadKeysForUsers).toHaveBeenCalledWith([ME]);
      expect(crypto.userHasCrossSigningKeys).not.toHaveBeenCalled();
    });
  });

  describe('serverDefaultKeyId', () => {
    it('reads a missing pointer as null and other failures as failures', async () => {
      const { engine, client } = setup();
      client.http.authedRequest.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
      );
      expect(await firstValueFrom(engine.serverDefaultKeyId(ME))).toEqual({
        ok: true,
        value: null,
      });

      client.http.authedRequest.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_UNKNOWN' }, 500),
      );
      expect(await firstValueFrom(engine.serverDefaultKeyId(ME))).toMatchObject(
        { ok: false, failure: { code: 'request-failed' } },
      );
    });
  });
});
