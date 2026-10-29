// The setup and reset steps over matrix-js-sdk: what each step asks of the SDK. Their
// ORDER is Trust's, guarded on the fake engine in trust-recovery-reset.spec.ts.
import { TestBed } from '@angular/core/testing';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import type { BootstrapCrossSigningOpts } from 'matrix-js-sdk/lib/crypto-api';
import { type Observable, firstValueFrom, lastValueFrom, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { EngineResult } from '@trinity/util/matrix';
import type { InteractiveUpdate } from '../trust-engine';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';

const ME = '@me:hs';
const DEFAULT_KEY = 'm.secret_storage.default_key';

/** A 401 UIA challenge carrying flows + session, as the SDK surfaces it. */
const challenge = (session: string) =>
  new MatrixError({ flows: [{ stages: ['m.login.password'] }], session }, 401);

type MakeRequest = (auth: unknown) => Promise<unknown>;

function setup({ withCrypto = true } = {}) {
  const crypto = {
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({
      encodedPrivateKey: 'EsTShown',
      privateKey: new Uint8Array(32),
    })),
    bootstrapCrossSigning: vi.fn(async (_opts: BootstrapCrossSigningOpts) => {
      // The SDK's upload callback, with a request that needs no auth by default.
    }),
    bootstrapSecretStorage: vi.fn(
      async (_opts: {
        setupNewKeyBackup?: boolean;
        createSecretStorageKey?: () => Promise<unknown>;
      }) => undefined,
    ),
  };
  const storage = {
    getDefaultKeyId: vi.fn(async (): Promise<string | null> => null),
    setDefaultKeyId: vi.fn(
      async (_keyId: string | null): Promise<void> => undefined,
    ),
    store: vi.fn(async (_name: string, _value: unknown) => undefined),
  };
  let userId = ME;
  const client = {
    getCrypto: () => (withCrypto ? crypto : undefined),
    getUserId: () => userId,
    secretStorage: storage,
    setAccountDataRaw: vi.fn(async (_type: string, _content: unknown) => ({})),
    http: { authedRequest: vi.fn(async (..._args: unknown[]) => ({})) },
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => (id === ME ? client : null) },
      },
    ],
  });
  return {
    engine: TestBed.inject(JsSdkTrustEngine),
    crypto,
    storage,
    client,
    switchUser: (to: string) => (userId = to),
  };
}

/** Makes the cross-signing upload run `makeRequest` through the engine's UIA callback. */
function uploadWith(
  crypto: ReturnType<typeof setup>['crypto'],
  makeRequest: MakeRequest,
) {
  crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
    await (
      opts.authUploadDeviceSigningKeys as unknown as (
        request: MakeRequest,
      ) => Promise<unknown>
    )(makeRequest);
  });
}

/** Runs an interactive command, answering each prompt from `answers`; returns the updates. */
async function run<T>(
  engine: JsSdkTrustEngine,
  updates: Observable<InteractiveUpdate<T>>,
  answers: (string | null)[] = [],
) {
  const seen: InteractiveUpdate<T>[] = [];
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
  const done = seen.at(-1);
  if (done?.kind !== 'done') throw new Error('No done update');
  return {
    prompts: seen.flatMap((u) =>
      u.kind === 'password-required' ? [u.rejected] : [],
    ),
    result: done.result,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

describe('JsSdkTrustEngine setup and reset steps', () => {
  describe('setUpRecovery', () => {
    it('bootstraps cross-signing, then secret storage with a NEW backup, returning the key', async () => {
      const { engine, crypto } = setup();

      const { result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
      );

      expect(result).toEqual({ ok: true, value: { recoveryKey: 'EsTShown' } });
      const crossSigning = crypto.bootstrapCrossSigning.mock.calls[0][0];
      expect(crossSigning.setupNewCrossSigning).toBeUndefined();
      expect(crossSigning.authUploadDeviceSigningKeys).toBeTypeOf('function');
      const ssOpts = crypto.bootstrapSecretStorage.mock.calls[0][0];
      // resetKeyBackup opens by deleting every existing version (Q8: kept on purpose).
      expect(ssOpts.setupNewKeyBackup).toBe(true);
      await expect(ssOpts.createSecretStorageKey?.()).resolves.toMatchObject({
        encodedPrivateKey: 'EsTShown',
      });
      expect(
        crypto.bootstrapCrossSigning.mock.invocationCallOrder[0],
      ).toBeLessThan(crypto.bootstrapSecretStorage.mock.invocationCallOrder[0]);
    });

    it('creates new cross-signing keys only for a new identity', async () => {
      const { engine, crypto } = setup();

      await run(engine, engine.setUpRecovery(ME, { newIdentity: true }));

      expect(
        crypto.bootstrapCrossSigning.mock.calls[0][0].setupNewCrossSigning,
      ).toBe(true);
    });

    it('does not prompt when the upload needs no auth', async () => {
      const { engine, crypto } = setup();
      const makeRequest = vi.fn(async (_auth: unknown) => undefined);
      uploadWith(crypto, makeRequest);

      const { prompts } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
      );

      expect(prompts).toEqual([]);
      expect(makeRequest).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('submits the password against the upload session, asking again after a rejection', async () => {
      const { engine, crypto } = setup();
      const makeRequest = vi
        .fn<MakeRequest>()
        .mockRejectedValueOnce(challenge('s1')) // probe
        .mockRejectedValueOnce(challenge('s2')) // wrong password
        .mockResolvedValueOnce(undefined);
      uploadWith(crypto, makeRequest);

      const { prompts, result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
        ['wrong', 'right'],
      );

      expect(result.ok).toBe(true);
      expect(prompts).toEqual([false, true]);
      expect(makeRequest.mock.calls[1][0]).toMatchObject({
        type: 'm.login.password',
        password: 'wrong',
        session: 's1',
      });
      expect(makeRequest.mock.calls[2][0]).toMatchObject({
        password: 'right',
        session: 's2',
      });
    });

    it('authenticates as the user it started as, even if the client changes user meanwhile', async () => {
      const { engine, crypto, switchUser } = setup();
      crypto.createRecoveryKeyFromPassphrase.mockImplementation(async () => {
        switchUser('@other:hs');
        return {
          encodedPrivateKey: 'EsTShown',
          privateKey: new Uint8Array(32),
        };
      });
      const makeRequest = vi
        .fn<MakeRequest>()
        .mockRejectedValueOnce(challenge('s1'))
        .mockResolvedValueOnce(undefined);
      uploadWith(crypto, makeRequest);

      await run(engine, engine.setUpRecovery(ME, { newIdentity: false }), [
        'pw',
      ]);

      expect(makeRequest.mock.calls[1][0]).toMatchObject({
        identifier: { type: 'm.id.user', user: ME },
      });
    });

    it('ends as uia-cancelled when the prompt is cancelled, before secret storage', async () => {
      const { engine, crypto } = setup();
      uploadWith(
        crypto,
        vi.fn<MakeRequest>().mockRejectedValue(challenge('s1')),
      );

      const { result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
        [null],
      );

      expect(result.ok ? 'ok' : result.failure.code).toBe('uia-cancelled');
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('ends as uia-unsupported, without a prompt, for an account with no password stage', async () => {
      const { engine, crypto } = setup();
      uploadWith(
        crypto,
        vi
          .fn<MakeRequest>()
          .mockRejectedValue(
            new MatrixError(
              { flows: [{ stages: ['m.login.sso'] }], session: 's' },
              401,
            ),
          ),
      );

      const { prompts, result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
      );

      expect(prompts).toEqual([]);
      expect(result.ok ? 'ok' : result.failure.code).toBe('uia-unsupported');
    });

    it('reports a non-UIA failure of the upload without prompting', async () => {
      const { engine, crypto } = setup();
      uploadWith(
        crypto,
        vi
          .fn<MakeRequest>()
          .mockRejectedValue(
            new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
          ),
      );

      const { prompts, result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
      );

      expect(prompts).toEqual([]);
      expect(result.ok ? 'ok' : result.failure.code).toBe('request-failed');
    });

    it('fails with crypto-not-ready for an account without crypto', async () => {
      const { engine } = setup({ withCrypto: false });

      const { result } = await run(
        engine,
        engine.setUpRecovery(ME, { newIdentity: false }),
      );

      expect(result.ok ? 'ok' : result.failure.code).toBe('crypto-not-ready');
    });
  });

  describe('rotateCrossSigning', () => {
    it('rotates and replays the password into the upload’s own session, without asking', async () => {
      const { engine, crypto } = setup();
      const makeRequest = vi
        .fn<MakeRequest>()
        .mockRejectedValueOnce(challenge('upload'))
        .mockResolvedValueOnce(undefined);
      uploadWith(crypto, makeRequest);

      const { prompts, result } = await run(
        engine,
        engine.rotateCrossSigning(ME, 's3cret'),
      );

      expect(result.ok).toBe(true);
      expect(prompts).toEqual([]);
      expect(
        crypto.bootstrapCrossSigning.mock.calls[0][0].setupNewCrossSigning,
      ).toBe(true);
      expect(makeRequest.mock.calls[1][0]).toMatchObject({
        password: 's3cret',
        session: 'upload',
      });
      // Neither secret storage nor the backup is touched.
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('asks, flagged rejected, when the replayed password is refused', async () => {
      const { engine, crypto } = setup();
      const makeRequest = vi
        .fn<MakeRequest>()
        .mockRejectedValueOnce(challenge('u1')) // probe
        .mockRejectedValueOnce(challenge('u2')) // the replay is refused
        .mockResolvedValueOnce(undefined);
      uploadWith(crypto, makeRequest);

      const { prompts } = await run(
        engine,
        engine.rotateCrossSigning(ME, 'accepted-then-changed'),
        ['typed-again'],
      );

      expect(prompts).toEqual([true]);
      expect(makeRequest.mock.calls[2][0]).toMatchObject({
        password: 'typed-again',
      });
    });

    it('still gives the person three tries after a refused replay', async () => {
      const { engine, crypto } = setup();
      uploadWith(
        crypto,
        vi.fn<MakeRequest>().mockRejectedValue(challenge('u')),
      );

      const { prompts, result } = await run(
        engine,
        engine.rotateCrossSigning(ME, 'unchanged'),
        ['a', 'b', 'c', 'd'],
      );

      expect(prompts).toHaveLength(3);
      expect(result.ok ? 'ok' : result.failure.code).toBe(
        'uia-attempts-exceeded',
      );
    });

    it('asks from the first challenge when there is nothing to replay', async () => {
      const { engine, crypto } = setup();
      uploadWith(
        crypto,
        vi
          .fn<MakeRequest>()
          .mockRejectedValueOnce(challenge('u'))
          .mockResolvedValueOnce(undefined),
      );

      const { prompts } = await run(
        engine,
        engine.rotateCrossSigning(ME, null),
        ['pw'],
      );

      expect(prompts).toEqual([false]);
    });
  });

  describe('setDefaultKeyPointer', () => {
    it('parks a set pointer and reports what it was', async () => {
      const { engine, storage } = setup();
      storage.getDefaultKeyId.mockResolvedValue('old-key');

      const result = await firstValueFrom(
        engine.setDefaultKeyPointer(ME, null, 'confirmed'),
      );

      expect(result).toEqual({
        ok: true,
        value: { previous: 'old-key', confirmed: true },
      });
      expect(storage.setDefaultKeyId).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('writes nothing when the local store already agrees', async () => {
      // On an agreeing store setDefaultKeyId writes nothing and never resolves.
      const { engine, storage } = setup();
      storage.getDefaultKeyId.mockResolvedValue('old-key');
      storage.setDefaultKeyId.mockReturnValue(new Promise(() => undefined));

      const result = await firstValueFrom(
        engine.setDefaultKeyPointer(ME, 'old-key', 'confirmed'),
      );

      expect(result).toEqual({
        ok: true,
        value: { previous: 'old-key', confirmed: true },
      });
      expect(storage.setDefaultKeyId).not.toHaveBeenCalled();
    });

    it('reports an unechoed write as unconfirmed within its budget', async () => {
      vi.useFakeTimers();
      const { engine, storage } = setup();
      storage.getDefaultKeyId.mockResolvedValue('old-key');
      storage.setDefaultKeyId.mockReturnValue(new Promise(() => undefined));

      const result = firstValueFrom(
        engine.setDefaultKeyPointer(ME, null, 'confirmed'),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual({
        ok: true,
        value: { previous: 'old-key', confirmed: false },
      });
    });

    it('writes the server copy with a bare PUT, reading nothing first', async () => {
      const { engine, storage, client } = setup();

      const result = await firstValueFrom(
        engine.setDefaultKeyPointer(ME, 'old-key', 'raw-retry'),
      );

      expect(result.ok).toBe(true);
      expect(client.setAccountDataRaw).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_KEY,
        { key: 'old-key' },
      );
      expect(storage.getDefaultKeyId).not.toHaveBeenCalled();
      expect(storage.setDefaultKeyId).not.toHaveBeenCalled();
    });

    it('retries the server write through a dropped connection', async () => {
      // A lost echo usually means the connection died, which is exactly when the next PUT
      // throws, so one blip must not lose the only write the rollback exists to make.
      vi.useFakeTimers();
      const retryLog = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        const { engine, client } = setup();
        client.setAccountDataRaw
          .mockRejectedValueOnce(new ConnectionError('flaky'))
          .mockResolvedValue({});

        const result = firstValueFrom(
          engine.setDefaultKeyPointer(ME, 'old-key', 'raw-retry'),
        );
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(result).resolves.toMatchObject({ ok: true });
        expect(client.setAccountDataRaw).toHaveBeenCalledTimes(2);
        expect(retryLog).toHaveBeenCalledExactlyOnceWith(
          'network operation failed 1 times, retrying in 2000ms...',
        );
      } finally {
        retryLog.mockRestore();
      }
    });
  });

  describe('the destructive tail', () => {
    it('deletes the dehydrated device over the unstable MSC3814 API', async () => {
      const { engine, client } = setup();

      expect(await firstValueFrom(engine.deleteDehydratedDevice(ME))).toEqual({
        ok: true,
        value: null,
      });
      expect(client.http.authedRequest).toHaveBeenCalledWith(
        'DELETE',
        '/dehydrated_device',
        undefined,
        {},
        { prefix: '/_matrix/client/unstable/org.matrix.msc3814.v1' },
      );
    });

    it('reports a server without a dehydrated device as a failure', async () => {
      const { engine, client } = setup();
      client.http.authedRequest.mockRejectedValue(
        new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
      );

      const result = await firstValueFrom(engine.deleteDehydratedDevice(ME));

      expect(result.ok ? 'ok' : result.failure.code).toBe('request-failed');
    });

    it('creates new secret storage with a NEW backup and returns the key', async () => {
      const { engine, crypto } = setup();

      const result = await firstValueFrom(engine.createRecoveryAndBackup(ME));

      expect(result).toEqual({ ok: true, value: { recoveryKey: 'EsTShown' } });
      const ssOpts = crypto.bootstrapSecretStorage.mock.calls[0][0];
      expect(ssOpts.setupNewKeyBackup).toBe(true);
      await expect(ssOpts.createSecretStorageKey?.()).resolves.toMatchObject({
        encodedPrivateKey: 'EsTShown',
      });
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    });

    it('drops the old key description once the default moved on', async () => {
      const { engine, storage } = setup();
      storage.getDefaultKeyId.mockResolvedValue('new-key');

      await firstValueFrom(engine.dropKeyDescription(ME, 'old-key'));

      expect(storage.store).toHaveBeenCalledExactlyOnceWith(
        'm.secret_storage.key.old-key',
        null,
      );
    });

    it('keeps the description while it is still the default', async () => {
      const { engine, storage } = setup();
      storage.getDefaultKeyId.mockResolvedValue('old-key');

      await firstValueFrom(engine.dropKeyDescription(ME, 'old-key'));

      expect(storage.store).not.toHaveBeenCalled();
    });
  });

  it('fails every step for an account that is not live', async () => {
    const { engine } = setup();
    const codes = await Promise.all(
      [
        engine.setDefaultKeyPointer('@nobody:hs', null, 'confirmed'),
        engine.deleteDehydratedDevice('@nobody:hs'),
        engine.createRecoveryAndBackup('@nobody:hs'),
        engine.dropKeyDescription('@nobody:hs', 'k'),
      ].map(async (step: Observable<EngineResult<unknown>>) => {
        const result = await firstValueFrom(step);
        return result.ok ? 'ok' : result.failure.code;
      }),
    );
    expect(codes).toEqual(Array(4).fill('account-not-live'));
  });
});
