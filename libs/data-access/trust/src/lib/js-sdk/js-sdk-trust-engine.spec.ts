import { TestBed } from '@angular/core/testing';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { MatrixError } from 'matrix-js-sdk';
import { type Observable, firstValueFrom, lastValueFrom, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { EngineResult } from '@trinity/util/matrix';
import type {
  InteractiveUpdate,
  OwnDevice,
  TrustFacts,
  UserTrustFacts,
} from '../trust-engine';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';

const ME = '@me:hs';

function setup({ withCrypto = true } = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const state = { verified: false, wasVerified: true };
  const crypto = {
    userHasCrossSigningKeys: vi.fn(async () => true),
    isCrossSigningReady: vi.fn(async () => state.verified),
    isSecretStorageReady: vi.fn(async () => false),
    getActiveSessionBackupVersion: vi.fn(async () => null),
    getDeviceVerificationStatus: vi.fn(
      async (_userId: string, deviceId?: string) => ({
        crossSigningVerified: state.verified,
        isVerified: () => deviceId === 'LAPTOP',
      }),
    ),
    getUserVerificationStatus: vi.fn(async (_userId: string) => ({
      isCrossSigningVerified: () => false,
      wasCrossSigningVerified: () => state.wasVerified,
      needsUserApproval: false,
    })),
    pinCurrentUserIdentity: vi.fn(async (_userId: string) => undefined),
    withdrawVerificationRequirement: vi.fn(async (_userId: string) => {
      state.wasVerified = false;
    }),
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
    getDevices: vi.fn(async () => ({
      devices: [
        { device_id: 'DEVICE', display_name: '', last_seen_ts: 200 },
        {
          device_id: 'LAPTOP',
          display_name: 'Laptop',
          last_seen_ip: '1.2.3.4',
        },
      ],
    })),
    setDeviceDetails: vi.fn(async () => ({})),
    deleteDevice: vi.fn(async (..._args: unknown[]) => ({})),
    deleteMultipleDevices: vi.fn(async (..._args: unknown[]) => ({})),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    }),
    off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
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
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
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
            releaseFirst = () =>
              resolve({ crossSigningVerified: false, isVerified: () => false });
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

  describe('ownDevices', () => {
    function watchDevices(engine: JsSdkTrustEngine) {
      const results: EngineResult<readonly OwnDevice[]>[] = [];
      const subscription = engine
        .ownDevices(ME)
        .subscribe((result) => results.push(result));
      return { results, subscription };
    }

    it('lists the devices with their verification, a failed status as unverified', async () => {
      const { engine, crypto } = setup();
      crypto.getDeviceVerificationStatus.mockRejectedValueOnce(
        new Error('store'),
      );
      const { results, subscription } = watchDevices(engine);

      await vi.waitFor(() => expect(results).toHaveLength(1));

      expect(results[0]).toEqual({
        ok: true,
        value: [
          {
            deviceId: 'DEVICE',
            displayName: null,
            lastSeenTs: 200,
            lastSeenIp: null,
            isCurrent: true,
            verified: false,
          },
          {
            deviceId: 'LAPTOP',
            displayName: 'Laptop',
            lastSeenTs: null,
            lastSeenIp: '1.2.3.4',
            isCurrent: false,
            verified: true,
          },
        ],
      });
      subscription.unsubscribe();
    });

    it('reads again only when the own device list changes after the first fetch', async () => {
      const { engine, client, emit } = setup();
      const { results, subscription } = watchDevices(engine);
      await vi.waitFor(() => expect(results).toHaveLength(1));
      client.getDevices.mockClear();

      emit(CryptoEvent.DevicesUpdated, ['@other:hs'], false);
      emit(CryptoEvent.DevicesUpdated, [ME], true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client.getDevices).not.toHaveBeenCalled();

      emit(CryptoEvent.DevicesUpdated, [ME], false);
      await vi.waitFor(() => expect(client.getDevices).toHaveBeenCalledOnce());
      subscription.unsubscribe();
      expect(client.off).toHaveBeenCalledTimes(client.on.mock.calls.length);
    });

    it('reports a failed list as request-failed', async () => {
      const { engine, client } = setup();
      client.getDevices.mockRejectedValueOnce(new Error('down'));
      const { results, subscription } = watchDevices(engine);

      await vi.waitFor(() => expect(results).toHaveLength(1));

      expect(results[0]).toMatchObject({
        ok: false,
        failure: { code: 'request-failed' },
      });
      subscription.unsubscribe();
    });

    it('reads again after this engine renames or deletes a device', async () => {
      const { engine, client } = setup();
      const { results, subscription } = watchDevices(engine);
      await vi.waitFor(() => expect(results).toHaveLength(1));

      await firstValueFrom(engine.renameDevice(ME, 'LAPTOP', 'Work'));
      await vi.waitFor(() =>
        expect(client.getDevices).toHaveBeenCalledTimes(2),
      );
      expect(client.setDeviceDetails).toHaveBeenCalledWith('LAPTOP', {
        display_name: 'Work',
      });

      await lastValueFrom(engine.deleteDevice(ME, 'LAPTOP'));
      await vi.waitFor(() =>
        expect(client.getDevices).toHaveBeenCalledTimes(3),
      );
      subscription.unsubscribe();
    });
  });

  describe('password prompts', () => {
    const challenge = (flows = [{ stages: ['m.login.password'] }]) =>
      new MatrixError(
        { errcode: 'M_FORBIDDEN', error: 'auth', flows, session: 'S' },
        401,
      );

    /** Answers each prompt from `answers` in turn; records the updates. */
    async function drive(
      engine: JsSdkTrustEngine,
      updates: Observable<InteractiveUpdate<unknown>>,
      answers: (string | null)[],
    ) {
      const seen: InteractiveUpdate<unknown>[] = [];
      await lastValueFrom(
        updates.pipe(
          tap((update) => {
            seen.push(update);
            if (update.kind === 'password-required') {
              engine
                .answerPrompt(ME, update.promptId, answers.shift() ?? null)
                .subscribe();
            }
          }),
        ),
      );
      return seen;
    }

    it('deletes without a prompt when the server asks for none', async () => {
      const { engine, client } = setup();

      const seen = await drive(engine, engine.deleteDevice(ME, 'LAPTOP'), []);

      expect(seen).toEqual([
        { kind: 'done', result: { ok: true, value: null } },
      ]);
      expect(client.deleteDevice).toHaveBeenCalledWith('LAPTOP', undefined);
    });

    it('raises a prompt, sends the answer, and flags a rejected one', async () => {
      const { engine, client } = setup();
      client.deleteDevice
        .mockRejectedValueOnce(challenge())
        .mockRejectedValueOnce(challenge())
        .mockResolvedValueOnce({});

      const seen = await drive(engine, engine.deleteDevice(ME, 'LAPTOP'), [
        'wrong',
        'hunter2',
      ]);

      expect(seen).toMatchObject([
        { kind: 'password-required', rejected: false },
        { kind: 'password-required', rejected: true },
        { kind: 'done', result: { ok: true } },
      ]);
      expect(client.deleteDevice.mock.calls[2][1]).toEqual({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: ME },
        password: 'hunter2',
        session: 'S',
      });
    });

    it('gives up after three rejected passwords without echoing them', async () => {
      const { engine, client } = setup();
      client.deleteDevice.mockRejectedValue(challenge());

      const seen = await drive(engine, engine.deleteDevice(ME, 'LAPTOP'), [
        'secret-1',
        'secret-2',
        'secret-3',
      ]);

      expect(seen.at(-1)).toMatchObject({
        kind: 'done',
        result: { ok: false, failure: { code: 'uia-attempts-exceeded' } },
      });
      expect(seen.filter((u) => u.kind === 'password-required')).toHaveLength(
        3,
      );
      expect(JSON.stringify(seen)).not.toContain('secret-');
    });

    it.each([
      ['a cancelled prompt', [null], 'uia-cancelled'],
      ['a non-password stage', [], 'uia-unsupported'],
    ] as const)('ends %s as %s', async (_case, answers, code) => {
      const { engine, client } = setup();
      client.deleteDevice.mockRejectedValueOnce(
        code === 'uia-unsupported'
          ? challenge([{ stages: ['m.login.sso'] }])
          : challenge(),
      );

      const seen = await drive(engine, engine.deleteDevice(ME, 'LAPTOP'), [
        ...answers,
      ]);

      expect(seen.at(-1)).toMatchObject({
        kind: 'done',
        result: { ok: false, failure: { code } },
      });
      expect(client.deleteDevice).toHaveBeenCalledOnce();
    });

    it('reports a refusal outside the prompt as forbidden', async () => {
      const { engine, client } = setup();
      client.deleteDevice.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
      );

      const seen = await drive(engine, engine.deleteDevice(ME, 'LAPTOP'), []);

      expect(seen).toMatchObject([
        { kind: 'done', result: { ok: false, failure: { code: 'forbidden' } } },
      ]);
    });

    it('refuses to delete the device it runs as', async () => {
      const { engine, client } = setup();

      const seen = await drive(engine, engine.deleteDevice(ME, 'DEVICE'), []);

      expect(seen).toMatchObject([
        {
          kind: 'done',
          result: { ok: false, failure: { code: 'unsupported' } },
        },
      ]);
      expect(client.deleteDevice).not.toHaveBeenCalled();
    });

    it('cancels an open prompt on unsubscribe; the prompt is then gone', async () => {
      const { engine, client } = setup();
      client.deleteDevice.mockRejectedValueOnce(challenge());
      let promptId = '';
      const subscription = engine
        .deleteDevice(ME, 'LAPTOP')
        .subscribe((update) => {
          if (update.kind === 'password-required') promptId = update.promptId;
        });
      await vi.waitFor(() => expect(promptId).not.toBe(''));

      subscription.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(client.deleteDevice).toHaveBeenCalledOnce();
      expect(
        await firstValueFrom(engine.answerPrompt(ME, promptId, 'late')),
      ).toMatchObject({ ok: false, failure: { code: 'prompt-gone' } });
    });

    it("answers only the account's own prompts", async () => {
      const { engine, client } = setup();
      client.deleteDevice.mockRejectedValueOnce(challenge());
      let promptId = '';
      const subscription = engine
        .deleteDevice(ME, 'LAPTOP')
        .subscribe((update) => {
          if (update.kind === 'password-required') promptId = update.promptId;
        });
      await vi.waitFor(() => expect(promptId).not.toBe(''));

      expect(
        await firstValueFrom(engine.answerPrompt('@other:hs', promptId, 'pw')),
      ).toMatchObject({ ok: false, failure: { code: 'prompt-gone' } });
      subscription.unsubscribe();
    });

    it('pre-authenticates with an empty delete and returns the accepted password', async () => {
      const { engine, client } = setup();
      client.deleteMultipleDevices
        .mockRejectedValueOnce(challenge())
        .mockResolvedValueOnce({});

      const seen = await drive(engine, engine.preAuthenticate(ME), ['hunter2']);

      expect(seen.at(-1)).toEqual({
        kind: 'done',
        result: { ok: true, value: { password: 'hunter2' } },
      });
      expect(client.deleteMultipleDevices.mock.calls[0][0]).toEqual([]);
    });
  });

  describe('userTrust', () => {
    it('reads the user, and again only when that user changes', async () => {
      const { engine, crypto, emit } = setup();
      const results: EngineResult<UserTrustFacts>[] = [];
      const subscription = engine
        .userTrust(ME, '@bob:hs')
        .subscribe((result) => results.push(result));
      await vi.waitFor(() => expect(results).toHaveLength(1));
      expect(results[0]).toEqual({
        ok: true,
        value: { verified: false, wasVerified: true, needsApproval: false },
      });

      emit(CryptoEvent.UserTrustStatusChanged, '@carol:hs');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(crypto.getUserVerificationStatus).toHaveBeenCalledOnce();

      crypto.getUserVerificationStatus.mockRejectedValueOnce(new Error('x'));
      emit(CryptoEvent.UserTrustStatusChanged, '@bob:hs');
      await vi.waitFor(() => expect(results).toHaveLength(2));
      // A failed read shows the user as unverified.
      expect(results[1]).toEqual({
        ok: true,
        value: { verified: false, wasVerified: false, needsApproval: false },
      });
      subscription.unsubscribe();
    });

    it('reads again after this engine withdraws the verification', async () => {
      const { engine, crypto } = setup();
      const results: EngineResult<UserTrustFacts>[] = [];
      const subscription = engine
        .userTrust(ME, '@bob:hs')
        .subscribe((result) => results.push(result));
      await vi.waitFor(() => expect(results).toHaveLength(1));

      expect(
        await firstValueFrom(engine.withdrawVerification(ME, '@bob:hs')),
      ).toEqual({ ok: true, value: null });

      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(results[1]).toMatchObject({ value: { wasVerified: false } });
      expect(crypto.withdrawVerificationRequirement).toHaveBeenCalledWith(
        '@bob:hs',
      );
      subscription.unsubscribe();
    });

    it('fails identity commands for an account without crypto', async () => {
      const { engine } = setup({ withCrypto: false });

      expect(
        await firstValueFrom(engine.pinIdentity(ME, '@bob:hs')),
      ).toMatchObject({ ok: false, failure: { code: 'crypto-not-ready' } });
    });
  });
});
