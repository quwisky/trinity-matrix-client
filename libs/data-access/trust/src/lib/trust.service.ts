import { Injectable, inject } from '@angular/core';
import { Method, type UIAuthCallback } from 'matrix-js-sdk';
import {
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
} from 'matrix-js-sdk/lib/crypto-api';
import type {
  SecretStorageKeyDescriptionAesV1,
  ServerSideSecretStorage,
} from 'matrix-js-sdk/lib/secret-storage';
import { Observable, catchError, defer, from, map, of, throwError } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustCryptoApi,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  decryptMegolmKeyFile,
  encryptMegolmKeyFile,
  runPasswordUia,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import {
  hasStrandedCrossSigning,
  repairStaleCrossSigning,
} from './cross-signing-repair';
import {
  DEFAULT_KEY_EVENT,
  PartialRecoveryResetError,
  encodedRecoveryKey,
  runRecoveryReset,
  withTimeout,
} from './recovery-reset';
import {
  TrustOperationError,
  recoverTrustOperation,
  trustOperationFailure,
  type TrustOperation,
} from './trust-operation-error';
import {
  TRUST_PROVIDER_RECOVERY,
  type TrustProviderManagement,
} from './trust-provider-recovery.port';
import { TrustHealthService } from './trust-health.service';

export type {
  TrustHealth,
  TrustHealthSnapshot,
  TrustStatus,
} from './trust-health.service';

const CROSS_SIGNING_RESET_ACTION = 'org.matrix.cross_signing_reset';

/**
 * The account-level Trust module on top of the lifecycle-free {@link TrustCryptoPort}:
 * bootstraps
 * cross-signing + secret storage (4S) + key backup, exposes readiness as signals,
 * and recovers a fresh device from the recovery key. Wraps `client.getCrypto()`
 * (the CryptoApi) so components never touch matrix-js-sdk directly.
 *
 * Two entry flows (see docs/architecture/matrix-and-encryption.md):
 * - {@link setUp}: first device — generate a recovery key, set up cross-signing,
 *   secret storage and a server key backup. Needs UIA (the user's password) to
 *   upload the new device-signing keys.
 * - {@link recoverWithKey} / {@link recoverWithPassphrase}: a later device — unlock
 *   4S so the cross-signing secrets and backup key gossip in and this device is
 *   trusted. No UIA: the keys already exist server-side.
 */
@Injectable({ providedIn: 'root' })
export class TrustService {
  private readonly cryptoPort = inject(TrustCryptoPort);
  private readonly providerRecovery = inject(TRUST_PROVIDER_RECOVERY);
  private readonly healthRuntime = inject(TrustHealthService);

  /** Atomic Trust state; no caller can observe a status assembled across generations. */
  readonly health = this.healthRuntime.health;
  /** Compatibility projections for the existing Trust surfaces. */
  readonly status = this.healthRuntime.status;
  readonly keyBackupActive = this.healthRuntime.keyBackupActive;
  readonly thisDeviceVerified = this.healthRuntime.thisDeviceVerified;

  /** Cold Trust-health projection retained by the named session lifetime. */
  runProjection(): Observable<void> {
    return this.healthRuntime.runProjection();
  }

  /** Retry a retained failed health projection without replacing its session owner. */
  retryProjection(): void {
    this.healthRuntime.retryProjection();
  }

  /** Re-evaluate the status signals against the current crypto state. */
  refresh(): Observable<void> {
    return this.healthRuntime.refresh();
  }

  /**
   * First-device setup (flow A): create a recovery key, bootstrap cross-signing,
   * secret storage and a new key backup. Emits the encoded recovery key string for
   * the user to save — it is shown once and never persisted.
   *
   * The key is generated randomly (no passphrase), so accounts onboarded here are
   * recovered via {@link recoverWithKey}, not {@link recoverWithPassphrase}.
   *
   * Refuses outright on an account that already has a 4S key — see
   * {@link assertNoRecoveryOnAccount} for why that check reads the server rather than
   * this device's own view of it.
   */
  setUp(promptPassword: PasswordPrompt): Observable<string> {
    return defer(() =>
      from(
        (async (): Promise<string> => {
          // Captured once: the server read and the key generation below are both awaits,
          // and an account switch mid-flight must not retarget the UIA user id onto a
          // different account (or find no client at all, once the old one signed out).
          const context = this.cryptoPort.active();
          const client = context.client;
          const crypto = this.requireCrypto('setup', context.crypto);
          const userId = client.getUserId() ?? '';
          await assertNoRecoveryOnAccount(client);
          const recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
          await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: this.passwordUia(
              promptPassword,
              userId,
            ),
          });
          await crypto.bootstrapSecretStorage({
            setupNewKeyBackup: true,
            createSecretStorageKey: async () => recoveryKey,
          });
          await this.healthRuntime.reconcile();
          return encodedRecoveryKey(recoveryKey);
        })(),
      ),
    ).pipe(recoverTrustOperation('setup'));
  }

  /**
   * Last resort (flow C): throw the account's encryption identity away and build a new
   * one, for someone who has lost their recovery key and has no other verified device.
   *
   * Emits the new recovery key, exactly as {@link setUp} does, so the same shown-once
   * display can present it. **This destroys data and cannot be undone** — see
   * {@link runRecoveryReset}, which owns the ordering that makes a refused reset free.
   */
  resetRecovery(promptPassword: PasswordPrompt): Observable<string> {
    return defer(() => {
      // Captured once: the reset spans several awaits, and an account switch mid-flight
      // must not retarget the rollback (or the UIA user id) onto a different account.
      const context = this.cryptoPort.active();
      const client = context.client;
      return from(
        runRecoveryReset(
          {
            crypto: this.requireCrypto('reset-recovery', context.crypto),
            client,
            storage: client.secretStorage,
            userId: client.getUserId() ?? '',
            refreshStatus: () => this.healthRuntime.reconcile(),
          },
          promptPassword,
        ),
      );
    }).pipe(
      catchError((cause: unknown) =>
        throwError(() =>
          trustOperationFailure(
            'reset-recovery',
            cause,
            cause instanceof PartialRecoveryResetError,
          ),
        ),
      ),
    );
  }

  /** Provider-hosted cross-signing reset link, resolved only after a typed refusal. */
  providerResetLink(): Observable<string | null> {
    return defer(() => this.providerRecovery.accountManagement()).pipe(
      map((management) =>
        management ? crossSigningResetUrl(management) : null,
      ),
      catchError(() => of(null)),
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
        throw new TrustOperationError(
          'recover',
          'unsupported',
          'reenter-secret',
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
   * Export this device's Megolm room keys as a passphrase-encrypted file, in the
   * interoperable Matrix key-export format (the same `.txt` Element reads/writes). Cold —
   * exports + encrypts on subscribe. A safety net independent of the server key backup.
   */
  exportRoomKeys(passphrase: string): Observable<string> {
    return defer(() =>
      from(
        (async (): Promise<string> => {
          const json =
            await this.requireCrypto('export-keys').exportRoomKeysAsJson();
          return encryptMegolmKeyFile(json, passphrase);
        })(),
      ),
    ).pipe(recoverTrustOperation('export-keys'));
  }

  /**
   * Import Megolm room keys from a passphrase-encrypted export file. Cold — decrypts +
   * imports on subscribe. A wrong passphrase (or a corrupted file) surfaces as an error
   * rather than importing nothing.
   */
  importRoomKeys(armored: string, passphrase: string): Observable<void> {
    return defer(() =>
      from(
        (async (): Promise<void> => {
          // Resolved before the decrypt, which is long enough to span an account
          // switch: these keys belong to the account the import was started on.
          const crypto = this.requireCrypto('import-keys');
          let json: string;
          try {
            json = await decryptMegolmKeyFile(armored, passphrase);
          } catch {
            throw new TrustOperationError(
              'import-keys',
              'invalid-secret',
              'reenter-secret',
              'The key export or its passphrase could not be verified.',
            );
          }
          await crypto.importRoomKeysAsJson(json);
        })(),
      ),
    ).pipe(recoverTrustOperation('import-keys'));
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
          const context = this.cryptoPort.active();
          const crypto = this.requireCrypto('recover', context.crypto);
          // Capture the account's 4S holder up front so a mid-recovery account switch
          // can't retarget the cached key onto a different account's holder.
          const holder = this.cryptoPort.secretStorageKey();
          const client = context.client;
          const secretStorage = client.secretStorage;
          const keyId = await secretStorage.getDefaultKeyId();
          const tuple = keyId ? await secretStorage.getKey(keyId) : null;
          if (!keyId || !tuple) {
            throw new TrustOperationError(
              'recover',
              'recovery-not-configured',
              'verify-another-device',
              'No recovery key is set up on this account.',
            );
          }
          const keyInfo = tuple[1];
          const { privateKey } = await resolveKey(keyInfo);
          if (!(await secretStorage.checkKey(privateKey, keyInfo))) {
            privateKey.fill(0);
            throw new TrustOperationError(
              'recover',
              'invalid-secret',
              'reenter-secret',
              'That recovery key is incorrect.',
            );
          }

          holder?.set(keyId, privateKey);
          // Pulls the cross-signing private keys out of 4S and trusts this device;
          // no UIA, since the keys already exist server-side.
          await crypto.bootstrapCrossSigning({});

          // ...unless the olm machine already holds privates, in which case that call
          // does nothing at all — including when they are the ones a reset rotated and
          // never published (see repairStaleCrossSigning). Unlocking 4S is exactly when
          // that is both detectable and fixable, so do it here rather than leaving the
          // device stuck at needs-recovery forever.
          await this.repairStrandedIdentity(
            crypto,
            secretStorage,
            client.getDeviceId(),
          );

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
          await this.healthRuntime.reconcile();
        })(),
      ),
    ).pipe(recoverTrustOperation('recover'));
  }

  /**
   * Evict cross-signing privates stranded by an interrupted reset, when that is what this
   * device is actually holding — see {@link hasStrandedCrossSigning} for why the check is
   * narrower than "cross-signing isn't ready".
   *
   * The repair is optional in a way the recovery around it is not. It sits after
   * `bootstrapCrossSigning`, which may already have trusted this device, and it can fail
   * for reasons that say nothing about the user's key: `exportSecretsBundle` /
   * `importSecretsBundle` are optional on `CryptoApi`, the bundle shape is probed at
   * runtime, and the WASM crate refuses to export unless all three privates are present.
   * A user who typed the CORRECT key must not be shown a raw SDK error over a device that
   * is in fact trusted — so a failure recomputes the status first and is only re-raised
   * when the device really is still untrusted. Loud when it matters, silent when the
   * recovery worked anyway.
   */
  private async repairStrandedIdentity(
    crypto: TrustCryptoApi,
    storage: ServerSideSecretStorage,
    deviceId: string | null,
  ): Promise<void> {
    if (!(await hasStrandedCrossSigning(crypto))) {
      return;
    }
    try {
      await repairStaleCrossSigning(crypto, storage, deviceId);
    } catch (err) {
      await this.healthRuntime.reconcile();
      if (this.health().current?.thisDeviceVerified !== true) {
        throw err;
      }
    }
  }

  /**
   * UIA callback for uploading new device-signing keys: defers to the shared
   * password-UIA loop (probe unauthenticated, then prompt + retry).
   *
   * `userId` is passed in rather than read here: the callback is built after several
   * awaits, so the account it authenticates as has to be the one the caller captured.
   */
  private passwordUia(
    promptPassword: PasswordPrompt,
    userId: string,
  ): UIAuthCallback<void> {
    return (makeRequest) => runPasswordUia(makeRequest, promptPassword, userId);
  }

  private requireCrypto(
    operation: TrustOperation,
    crypto = this.cryptoPort.active().crypto,
  ): TrustCryptoApi {
    if (!crypto) {
      throw new TrustOperationError(
        operation,
        'not-ready',
        'retry',
        'Trust is not ready for this account yet.',
      );
    }
    return crypto;
  }

  private decode(recoveryKey: string): Uint8Array<ArrayBuffer> {
    try {
      return decodeRecoveryKey(recoveryKey.trim());
    } catch {
      throw new TrustOperationError(
        'recover',
        'invalid-secret',
        'reenter-secret',
        'That does not look like a valid recovery key.',
      );
    }
  }
}

/**
 * Refuse first-device setup on an account that already has a 4S key.
 *
 * {@link TrustService.setUp} is one click away from every `needs-setup` surface, and on
 * an account that is already set up it is destructive rather than idempotent:
 * `bootstrapSecretStorage({ setupNewKeyBackup: true })` mints a fresh 4S key — orphaning
 * the still-valid one the user holds — and `resetKeyBackup` opens by deleting every
 * key-backup version on the account.
 *
 * `needs-setup` is derived from `secretStorage.getDefaultKeyId()`, which after initial
 * sync answers from this client's LOCAL store, so it goes stale for as long as a /sync
 * echo is missing — up to the ~110s the sync loop takes to notice a dead long-poll. That
 * is precisely the window a rolled-back recovery reset opens, which is why the local view
 * cannot be the check here. Ask the server.
 *
 * **Fails open on purpose.** Only a pointer the server positively reports stops the setup;
 * an unreachable or unhappy server does not. This exists to block a known-destructive
 * action, not to become a new way for genuine first-run setup to fail.
 */
async function assertNoRecoveryOnAccount(
  client: TrustMatrixClient,
): Promise<void> {
  if (!(await readServerDefaultKeyId(client))) {
    return;
  }
  throw new TrustOperationError(
    'setup',
    'stale-state',
    'review-security-settings',
    'This account already has a recovery key. Unlock this device with that key instead — setting up a new one here would replace it and delete the account’s key backup.',
  );
}

/** A validated provider deep link for MSC2965 cross-signing reset. */
function crossSigningResetUrl(
  management: TrustProviderManagement,
): string | null {
  if (!management.actionsSupported.includes(CROSS_SIGNING_RESET_ACTION)) {
    return null;
  }
  try {
    const url = new URL(management.url);
    url.searchParams.set('action', CROSS_SIGNING_RESET_ACTION);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The account's 4S pointer as the SERVER has it, or null when there is none — which is
 * also what a failed read yields, since the caller fails open.
 */
async function readServerDefaultKeyId(
  client: TrustMatrixClient,
): Promise<string | null> {
  const userId = client.getUserId();
  if (!userId) {
    return null;
  }
  try {
    // Use the tighter crypto-flow deadline rather than the client's 30-second default, so
    // a socket the homeserver accepts and never answers cannot hold first-run setup. A
    // timeout lands in the same catch as every other read failure.
    const content = await withTimeout(
      client.http.authedRequest<{ key?: string }>(
        Method.Get,
        `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(DEFAULT_KEY_EVENT)}`,
      ),
    );
    return content.key ?? null;
  } catch {
    // `M_NOT_FOUND` is the ordinary first-run answer, and anything else (offline, 5xx,
    // a homeserver that stopped answering) is a read we cannot trust either way. Both
    // mean "let the setup proceed".
    return null;
  }
}
