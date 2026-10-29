import { TestBed } from '@angular/core/testing';
import {
  deriveRecoveryKeyFromPassphrase,
  encodeRecoveryKey,
} from 'matrix-js-sdk/lib/crypto-api';
import { MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { encryptMegolmKeyFile } from '@trinity/util/matrix';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';

// PBKDF2 over the real iteration count is slow; the derivation itself is the SDK's.
vi.mock('matrix-js-sdk/lib/crypto-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-js-sdk/lib/crypto-api')>()),
  deriveRecoveryKeyFromPassphrase: vi.fn(async () =>
    new Uint8Array(32).fill(1),
  ),
}));

const ME = '@me:hs';
const KEY = encodeRecoveryKey(new Uint8Array(32).fill(7)) as string;

const SEEDS: Record<string, string> = {
  'm.cross_signing.master': 'real-master',
  'm.cross_signing.self_signing': 'real-self',
  'm.cross_signing.user_signing': 'real-user',
};

/** The shape matrix-js-sdk exports for a SecretsBundle (serde field names). */
const bundle = () => ({
  cross_signing: {
    master_key: 'stale-master',
    self_signing_key: 'stale-self',
    user_signing_key: 'stale-user',
  },
  backup: { algorithm: 'm.megolm_backup.v1', key: 'bk', backup_version: '1' },
});

interface Options {
  defaultKeyId?: string | null;
  keyInfo?: Record<string, unknown>;
  checkKey?: boolean;
  backupInfo?: { version: string } | null;
  crossSigningReady?: boolean;
  deviceVerified?: boolean;
  privatesCachedLocally?: boolean;
  storedSecrets?: Record<string, string>;
  exportedKeys?: string;
}

function setup(options: Options = {}) {
  const crypto = {
    bootstrapCrossSigning: vi.fn(async (_opts: unknown) => undefined),
    getKeyBackupInfo: vi.fn(async () =>
      'backupInfo' in options ? options.backupInfo : { version: '1' },
    ),
    loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => undefined),
    checkKeyBackupAndEnable: vi.fn(async () => null),
    isCrossSigningReady: vi.fn(async () => options.crossSigningReady ?? true),
    getCrossSigningStatus: vi.fn(async () => ({
      publicKeysOnDevice: true,
      privateKeysInSecretStorage: Object.keys(SEEDS).every(
        (name) => options.storedSecrets?.[name],
      ),
      privateKeysCachedLocally: {
        masterKey: options.privatesCachedLocally ?? false,
        selfSigningKey: options.privatesCachedLocally ?? false,
        userSigningKey: options.privatesCachedLocally ?? false,
      },
    })),
    getDeviceVerificationStatus: vi.fn(async () => ({
      crossSigningVerified: options.deviceVerified ?? false,
    })),
    exportSecretsBundle: vi.fn(async (): Promise<unknown> => bundle()),
    importSecretsBundle: vi.fn(async (_bundle: unknown) => undefined),
    crossSignDevice: vi.fn(async (_deviceId: string) => undefined),
    exportRoomKeysAsJson: vi.fn(async () => options.exportedKeys ?? '[]'),
    importRoomKeysAsJson: vi.fn(async (_json: string) => undefined),
  };
  const defaultKeyId =
    options.defaultKeyId === undefined ? 'k' : options.defaultKeyId;
  const secretStorage = {
    getDefaultKeyId: vi.fn(async () => defaultKeyId),
    getKey: vi.fn(async (keyId: string) => [keyId, options.keyInfo ?? {}]),
    checkKey: vi.fn(
      async (_key: Uint8Array, _info: unknown) => options.checkKey ?? true,
    ),
    get: vi.fn(async (name: string) => options.storedSecrets?.[name]),
  };
  const client = {
    getCrypto: () => crypto,
    getDeviceId: () => 'DEVICE',
    getUserId: () => ME,
    secretStorage,
  };
  const holder = { set: vi.fn() };
  const clients = {
    clientFor: vi.fn((id: string) => (id === ME ? client : null)),
    holderFor: vi.fn((id: string) => (id === ME ? holder : null)),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: JS_SDK_CLIENTS, useValue: clients }],
  });
  return {
    engine: TestBed.inject(JsSdkTrustEngine),
    crypto,
    secretStorage,
    holder,
    clients,
  };
}

const withKey = { kind: 'recovery-key', value: KEY } as const;

afterEach(() => TestBed.resetTestingModule());

describe('JsSdkTrustEngine recovery', () => {
  it("unlocks with the key, caches it on the account's holder, imports cross-signing and enables backup", async () => {
    const { engine, crypto, secretStorage, holder, clients } = setup();

    expect(await firstValueFrom(engine.recover(ME, withKey))).toEqual({
      ok: true,
      value: null,
    });

    expect(secretStorage.checkKey).toHaveBeenCalledOnce();
    expect(clients.holderFor).toHaveBeenCalledExactlyOnceWith(ME);
    expect(holder.set).toHaveBeenCalledWith('k', new Uint8Array(32).fill(7));
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
    expect(
      crypto.loadSessionBackupPrivateKeyFromSecretStorage,
    ).toHaveBeenCalledOnce();
    expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledOnce();
  });

  it('refuses a wrong key, zeroing it, caching nothing and trusting nothing', async () => {
    const { engine, crypto, secretStorage, holder } = setup({
      checkKey: false,
    });

    expect(await firstValueFrom(engine.recover(ME, withKey))).toMatchObject({
      ok: false,
      failure: { code: 'recovery-refused', params: { reason: 'incorrect' } },
    });

    const [tried] = secretStorage.checkKey.mock.calls[0];
    expect(tried).toEqual(new Uint8Array(32));
    expect(holder.set).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('refuses a malformed key before checking it', async () => {
    const { engine, secretStorage } = setup();

    expect(
      await firstValueFrom(
        engine.recover(ME, { kind: 'recovery-key', value: 'not a key' }),
      ),
    ).toMatchObject({
      ok: false,
      failure: {
        code: 'recovery-refused',
        params: { reason: 'malformed-key' },
      },
    });
    expect(secretStorage.checkKey).not.toHaveBeenCalled();
  });

  it('refuses when the account has no secret storage', async () => {
    const { engine } = setup({ defaultKeyId: null });

    expect(await firstValueFrom(engine.recover(ME, withKey))).toMatchObject({
      ok: false,
      failure: {
        code: 'recovery-refused',
        params: { reason: 'not-configured' },
      },
    });
  });

  it('derives the key from the passphrase with the stored parameters', async () => {
    const { engine, holder } = setup({
      keyInfo: {
        passphrase: { algorithm: 'm.pbkdf2', salt: 'salty', iterations: 1 },
      },
    });

    expect(
      await firstValueFrom(
        engine.recover(ME, { kind: 'passphrase', value: 'hunter2' }),
      ),
    ).toEqual({ ok: true, value: null });
    expect(vi.mocked(deriveRecoveryKeyFromPassphrase)).toHaveBeenCalledWith(
      'hunter2',
      'salty',
      1,
      undefined,
    );
    expect(holder.set).toHaveBeenCalledWith('k', new Uint8Array(32).fill(1));
  });

  it('refuses a passphrase when secret storage has no passphrase', async () => {
    const { engine } = setup();

    expect(
      await firstValueFrom(
        engine.recover(ME, { kind: 'passphrase', value: 'hunter2' }),
      ),
    ).toMatchObject({
      ok: false,
      failure: {
        code: 'recovery-refused',
        params: { reason: 'no-passphrase' },
      },
    });
  });

  it('still recovers when enabling key backup fails', async () => {
    const { engine, crypto } = setup();
    crypto.loadSessionBackupPrivateKeyFromSecretStorage.mockRejectedValue(
      new Error('stale backup key in 4S'),
    );

    expect(await firstValueFrom(engine.recover(ME, withKey))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('skips the backup steps when no backup exists', async () => {
    const { engine, crypto } = setup({ backupInfo: null });

    await firstValueFrom(engine.recover(ME, withKey));

    expect(
      crypto.loadSessionBackupPrivateKeyFromSecretStorage,
    ).not.toHaveBeenCalled();
  });

  it('reports a failure without the key or the cause', async () => {
    const { engine, crypto } = setup();
    crypto.bootstrapCrossSigning.mockRejectedValue(new Error(`boom ${KEY}`));

    const result = await firstValueFrom(engine.recover(ME, withKey));

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'request-failed' },
    });
    expect(JSON.stringify(result)).not.toMatch(/boom|EsT/);
  });

  it('reports a refused signature upload as forbidden', async () => {
    const { engine, crypto } = setup();
    crypto.bootstrapCrossSigning.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );

    expect(await firstValueFrom(engine.recover(ME, withKey))).toMatchObject({
      ok: false,
      failure: { code: 'forbidden' },
    });
  });

  it('refuses an account that is not live', async () => {
    const { engine } = setup();

    expect(
      await firstValueFrom(engine.recover('@other:hs', withKey)),
    ).toMatchObject({ ok: false, failure: { code: 'account-not-live' } });
  });

  // An interrupted reset leaves the olm machine holding cross-signing privates it rotated
  // but never published. bootstrapCrossSigning({}) then sees privates in place and does
  // nothing, so unlocking 4S never replaced them and the device stayed untrusted.
  describe('cross-signing keys stranded by an interrupted reset', () => {
    const stranded: Options = {
      crossSigningReady: false,
      privatesCachedLocally: true,
      storedSecrets: SEEDS,
    };

    it('re-imports the real keys from 4S and cross-signs this device', async () => {
      const { engine, crypto } = setup(stranded);

      expect(await firstValueFrom(engine.recover(ME, withKey))).toEqual({
        ok: true,
        value: null,
      });

      expect(crypto.importSecretsBundle).toHaveBeenCalledWith({
        cross_signing: {
          master_key: 'real-master',
          self_signing_key: 'real-self',
          user_signing_key: 'real-user',
        },
        backup: bundle().backup,
      });
      expect(crypto.crossSignDevice).toHaveBeenCalledWith('DEVICE');
    });

    it('leaves a healthy device alone', async () => {
      const { engine, crypto } = setup({
        ...stranded,
        crossSigningReady: true,
      });

      await firstValueFrom(engine.recover(ME, withKey));

      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      expect(crypto.crossSignDevice).not.toHaveBeenCalled();
    });

    it('does nothing when 4S holds only some of the keys', async () => {
      const { engine, crypto } = setup({
        ...stranded,
        storedSecrets: { 'm.cross_signing.master': 'real-master' },
      });

      expect(await firstValueFrom(engine.recover(ME, withKey))).toEqual({
        ok: true,
        value: null,
      });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it('leaves an ordinary untrusted device, holding no privates, to the SDK', async () => {
      const { engine, crypto } = setup({
        ...stranded,
        privatesCachedLocally: false,
      });

      await firstValueFrom(engine.recover(ME, withKey));

      expect(crypto.exportSecretsBundle).not.toHaveBeenCalled();
    });

    it('keeps a recovery that worked when the repair itself cannot run', async () => {
      const { engine, crypto } = setup({ ...stranded, deviceVerified: true });
      crypto.exportSecretsBundle.mockRejectedValue(
        new Error('The secrets bundle could not be exported'),
      );

      expect(await firstValueFrom(engine.recover(ME, withKey))).toEqual({
        ok: true,
        value: null,
      });
    });

    it('fails if the SDK exports a bundle it does not recognise', async () => {
      const { engine, crypto } = setup(stranded);
      crypto.exportSecretsBundle.mockResolvedValue({
        crossSigning: { masterKey: 'renamed-upstream' },
      });

      expect(await firstValueFrom(engine.recover(ME, withKey))).toMatchObject({
        ok: false,
        failure: { code: 'request-failed' },
      });
      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it('fails if the SDK cannot import a secrets bundle at all', async () => {
      const { engine, crypto } = setup(stranded);
      crypto.importSecretsBundle = undefined as never;

      expect(await firstValueFrom(engine.recover(ME, withKey))).toMatchObject({
        ok: false,
        failure: { code: 'request-failed' },
      });
    });
  });
});

describe('JsSdkTrustEngine room keys', () => {
  it('exports the keys as an encrypted key file', async () => {
    const { engine, crypto } = setup({
      exportedKeys: JSON.stringify([{ room_id: '!r:hs', session_id: 's' }]),
    });

    const result = await firstValueFrom(engine.exportRoomKeys(ME, 'pw'));

    if (!result.ok) throw new Error(result.failure.code);
    expect(crypto.exportRoomKeysAsJson).toHaveBeenCalled();
    expect(result.value).toContain('-----BEGIN MEGOLM SESSION DATA-----');
    expect(result.value).not.toContain('!r:hs');
  });

  it('imports the keys of a file it exported', async () => {
    const keys = JSON.stringify([{ room_id: '!r:hs', session_id: 's' }]);
    const { engine, crypto } = setup({ exportedKeys: keys });
    const exported = await firstValueFrom(engine.exportRoomKeys(ME, 'pw'));
    if (!exported.ok) throw new Error(exported.failure.code);

    expect(
      await firstValueFrom(engine.importRoomKeys(ME, exported.value, 'pw')),
    ).toEqual({ ok: true, value: null });
    expect(crypto.importRoomKeysAsJson).toHaveBeenCalledWith(keys);
  });

  it('refuses a wrong passphrase and imports nothing', async () => {
    const { engine, crypto } = setup();
    const fileText = await encryptMegolmKeyFile('[]', 'right', 1);

    expect(
      await firstValueFrom(engine.importRoomKeys(ME, fileText, 'wrong')),
    ).toMatchObject({
      ok: false,
      failure: { code: 'recovery-refused', params: { reason: 'incorrect' } },
    });
    expect(crypto.importRoomKeysAsJson).not.toHaveBeenCalled();
  });

  it('reports a refused import as forbidden', async () => {
    const { engine, crypto } = setup();
    crypto.importRoomKeysAsJson.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );
    const fileText = await encryptMegolmKeyFile('[]', 'pw', 1);

    expect(
      await firstValueFrom(engine.importRoomKeys(ME, fileText, 'pw')),
    ).toMatchObject({ ok: false, failure: { code: 'forbidden' } });
  });

  it('imports into the crypto it found on subscribe, not a later client', async () => {
    const { engine, crypto, clients } = setup();
    const fileText = await encryptMegolmKeyFile('[]', 'pw', 1);
    const later = { importRoomKeysAsJson: vi.fn() };

    const pending = firstValueFrom(engine.importRoomKeys(ME, fileText, 'pw'));
    clients.clientFor.mockReturnValue({
      getCrypto: () => later,
    } as never);
    await pending;

    expect(crypto.importRoomKeysAsJson).toHaveBeenCalledWith('[]');
    expect(later.importRoomKeysAsJson).not.toHaveBeenCalled();
  });
});
