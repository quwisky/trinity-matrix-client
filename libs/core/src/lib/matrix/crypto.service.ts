import { Injectable, inject, signal } from '@angular/core';
import { type MatrixClient, type UIAuthCallback } from 'matrix-js-sdk';
import {
  CryptoEvent,
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  type CryptoApi,
  type GeneratedSecretStorageKey,
} from 'matrix-js-sdk/lib/crypto-api';
import type { SecretStorageKeyDescriptionAesV1 } from 'matrix-js-sdk/lib/secret-storage';
import { Observable, defer, from } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';
import { SecretStorageKeyService } from './secret-storage-key.service';
import { runPasswordUia, type PasswordPrompt } from './password-uia';

/**
 * Where this device stands relative to the account's encryption setup:
 * - `unknown`       — not yet computed (crypto not ready).
 * - `ready`         — cross-signing + secret storage are set up and trusted here.
 * - `needs-setup`   — no secret storage exists on the account yet (first device).
 * - `needs-recovery`— secret storage exists, but this device isn't trusted; the
 *                     user must unlock it with their recovery key / passphrase.
 */
export type CryptoStatus =
  | 'unknown'
  | 'ready'
  | 'needs-setup'
  | 'needs-recovery';

/**
 * The account-level secret layer on top of {@link MatrixClientService}: bootstraps
 * cross-signing + secret storage (4S) + key backup, exposes readiness as signals,
 * and recovers a fresh device from the recovery key. Wraps `client.getCrypto()`
 * (the CryptoApi) so components never touch matrix-js-sdk directly.
 *
 * Two entry flows (see docs/CRYPTO-BOOTSTRAP-PLAN.md):
 * - {@link setUp}: first device — generate a recovery key, set up cross-signing,
 *   secret storage and a server key backup. Needs UIA (the user's password) to
 *   upload the new device-signing keys.
 * - {@link recoverWithKey} / {@link recoverWithPassphrase}: a later device — unlock
 *   4S so the cross-signing secrets and backup key gossip in and this device is
 *   trusted. No UIA: the keys already exist server-side.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  private readonly matrix = inject(MatrixClientService);
  private readonly secretStorageKeys = inject(SecretStorageKeyService);

  /**
   * The client we currently have crypto listeners on. Keyed to the instance (not
   * a boolean) so a logout→login rewires onto the new client instead of leaving
   * the status signals frozen on the discarded one.
   */
  private connectedClient: MatrixClient | null = null;

  /** Stable listener ref so {@link connect}/{@link disconnect} can add and remove it. */
  private readonly onCryptoEvent = (): void => void this.computeStatus();

  private readonly _status = signal<CryptoStatus>('unknown');
  /** Primary signal that drives the encryption banner / setup vs unlock UI. */
  readonly status = this._status.asReadonly();

  private readonly _keyBackupActive = signal(false);
  /** Whether a server-side key backup is active for this session. */
  readonly keyBackupActive = this._keyBackupActive.asReadonly();

  private readonly _thisDeviceVerified = signal(false);
  /** Whether this device is cross-signing verified. */
  readonly thisDeviceVerified = this._thisDeviceVerified.asReadonly();

  /**
   * Attach crypto listeners and compute the initial status. Idempotent; call once
   * the client is live (alongside `RoomsService.connect()`).
   */
  connect(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return; // already wired to this client
    }
    this.disconnect(); // drop listeners from any previous client
    this.connectedClient = client;
    client.on(CryptoEvent.KeysChanged, this.onCryptoEvent);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onCryptoEvent);
    client.on(CryptoEvent.KeyBackupStatus, this.onCryptoEvent);
    client.on(CryptoEvent.DevicesUpdated, this.onCryptoEvent);
    void this.computeStatus();
  }

  /** Detach crypto listeners from the current client and reset status signals. */
  disconnect(): void {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    client.off(CryptoEvent.KeysChanged, this.onCryptoEvent);
    client.off(CryptoEvent.UserTrustStatusChanged, this.onCryptoEvent);
    client.off(CryptoEvent.KeyBackupStatus, this.onCryptoEvent);
    client.off(CryptoEvent.DevicesUpdated, this.onCryptoEvent);
    this.connectedClient = null;
    this._status.set('unknown');
    this._keyBackupActive.set(false);
    this._thisDeviceVerified.set(false);
  }

  /** Re-evaluate the status signals against the current crypto state. */
  refresh(): Observable<void> {
    return defer(() => from(this.computeStatus()));
  }

  /**
   * First-device setup (flow A): create a recovery key, bootstrap cross-signing,
   * secret storage and a new key backup. Emits the encoded recovery key string for
   * the user to save — it is shown once and never persisted.
   *
   * The key is generated randomly (no passphrase), so accounts onboarded here are
   * recovered via {@link recoverWithKey}, not {@link recoverWithPassphrase}.
   */
  setUp(promptPassword: PasswordPrompt): Observable<string> {
    return defer(() =>
      from(
        (async (): Promise<string> => {
          const crypto = this.requireCrypto();
          const recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
          await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: this.passwordUia(promptPassword),
          });
          await crypto.bootstrapSecretStorage({
            setupNewKeyBackup: true,
            createSecretStorageKey: async () => recoveryKey,
          });
          await this.computeStatus();
          return this.encoded(recoveryKey);
        })(),
      ),
    );
  }

  /** Unlock this device from the account's recovery key (flow B). */
  recoverWithKey(recoveryKey: string): Observable<void> {
    return this.recover(async () => ({ privateKey: this.decode(recoveryKey) }));
  }

  /**
   * Unlock this device from a recovery passphrase (flow B). Only works for accounts
   * whose 4S key was derived from a passphrase; {@link setUp} provisions a random
   * recovery key, so Trinity-onboarded accounts use {@link recoverWithKey} instead.
   */
  recoverWithPassphrase(passphrase: string): Observable<void> {
    return this.recover(async (keyInfo) => {
      const info = keyInfo.passphrase;
      if (!info) {
        throw new Error(
          'This account has no recovery passphrase — enter the recovery key instead.',
        );
      }
      const privateKey = await deriveRecoveryKeyFromPassphrase(
        passphrase,
        info.salt,
        info.iterations,
        info.bits,
      );
      return { privateKey };
    });
  }

  /**
   * Shared recovery body: resolve the private key (from a key or passphrase),
   * verify it against the stored key info, cache it for the SDK callbacks, import
   * cross-signing from 4S so this device becomes trusted, and enable key backup.
   * History decrypts lazily from the backup once enabled, so the (potentially
   * huge) bulk `restoreKeyBackup()` is intentionally skipped.
   */
  private recover(
    resolveKey: (
      keyInfo: SecretStorageKeyDescriptionAesV1,
    ) => Promise<{ privateKey: Uint8Array<ArrayBuffer> }>,
  ): Observable<void> {
    return defer(() =>
      from(
        (async (): Promise<void> => {
          const crypto = this.requireCrypto();
          const secretStorage = this.matrix.instance.secretStorage;
          const keyId = await secretStorage.getDefaultKeyId();
          const tuple = keyId ? await secretStorage.getKey(keyId) : null;
          if (!keyId || !tuple) {
            throw new Error('No recovery key is set up on this account.');
          }
          const keyInfo = tuple[1];
          const { privateKey } = await resolveKey(keyInfo);
          if (!(await secretStorage.checkKey(privateKey, keyInfo))) {
            privateKey.fill(0);
            throw new Error('That recovery key is incorrect.');
          }

          this.secretStorageKeys.set(keyId, privateKey);
          // Pulls the cross-signing private keys out of 4S and trusts this device;
          // no UIA, since the keys already exist server-side.
          await crypto.bootstrapCrossSigning({});

          // Enable key backup if one exists. The device is already trusted at this
          // point, so a missing/stale backup key in 4S must not fail the recovery —
          // backup can self-enable later via the crypto event listeners.
          try {
            if (await crypto.getKeyBackupInfo()) {
              await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
              await crypto.checkKeyBackupAndEnable();
            }
          } catch {
            // best effort; status still reflects the (successful) device trust below
          }
          await this.computeStatus();
        })(),
      ),
    );
  }

  /** Monotonic token so a slow status run can't overwrite a newer one. */
  private statusGeneration = 0;

  /**
   * Recompute the status signals; safe to call when crypto is unavailable and
   * resilient to concurrent invocations (events fire it). Best-effort: it never
   * rejects (callers fire it from listeners), and a superseded run drops its write.
   */
  private async computeStatus(): Promise<void> {
    const generation = ++this.statusGeneration;
    const isCurrent = (): boolean => generation === this.statusGeneration;
    try {
      const client = this.matrix.isInitialized ? this.matrix.instance : null;
      const crypto = client?.getCrypto();
      if (!client || !crypto) {
        if (isCurrent()) {
          this._status.set('unknown');
          this._keyBackupActive.set(false);
          this._thisDeviceVerified.set(false);
        }
        return;
      }

      const [
        crossSigningReady,
        secretStorageReady,
        backupVersion,
        defaultKeyId,
      ] = await Promise.all([
        crypto.isCrossSigningReady(),
        crypto.isSecretStorageReady(),
        crypto.getActiveSessionBackupVersion(),
        client.secretStorage.getDefaultKeyId(),
      ]);

      const deviceId = client.getDeviceId();
      const userId = client.getUserId();
      const deviceStatus =
        userId && deviceId
          ? await crypto.getDeviceVerificationStatus(userId, deviceId)
          : null;

      if (!isCurrent()) {
        return;
      }
      this._keyBackupActive.set(backupVersion !== null);
      this._thisDeviceVerified.set(deviceStatus?.crossSigningVerified ?? false);
      this._status.set(
        crossSigningReady && secretStorageReady
          ? 'ready'
          : defaultKeyId
            ? 'needs-recovery'
            : 'needs-setup',
      );
    } catch {
      // Transient crypto error: keep the last known signals rather than flapping.
    }
  }

  /**
   * UIA callback for uploading new device-signing keys: defers to the shared
   * password-UIA loop (probe unauthenticated, then prompt + retry).
   */
  private passwordUia(promptPassword: PasswordPrompt): UIAuthCallback<void> {
    const userId = this.matrix.instance.getUserId() ?? '';
    return (makeRequest) => runPasswordUia(makeRequest, promptPassword, userId);
  }

  private requireCrypto(): CryptoApi {
    const crypto = this.matrix.instance.getCrypto();
    if (!crypto) {
      throw new Error('Crypto is not initialized on the client.');
    }
    return crypto;
  }

  private decode(recoveryKey: string): Uint8Array<ArrayBuffer> {
    try {
      return decodeRecoveryKey(recoveryKey.trim());
    } catch {
      throw new Error('That does not look like a valid recovery key.');
    }
  }

  private encoded(key: GeneratedSecretStorageKey): string {
    if (!key.encodedPrivateKey) {
      throw new Error('Failed to generate a recovery key.');
    }
    return key.encodedPrivateKey;
  }
}
