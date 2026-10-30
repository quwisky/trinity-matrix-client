import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  map,
  of,
  take,
  throwError,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  type EngineFailure,
  type EngineResult,
  type RecoveryRefusal,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import { answerPasswordPrompts } from './password-prompts';
import { PartialRecoveryResetError, runRecoveryReset } from './recovery-reset';
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
import {
  assertNoIdentityElsewhere,
  assertNoRecoveryOnAccount,
} from './setup-guards';
import { TrustHealthService } from './trust-health.service';
import type { RecoverySecret } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';

export type {
  TrustHealth,
  TrustHealthSnapshot,
  TrustStatus,
} from './trust-health.service';

const CROSS_SIGNING_RESET_ACTION = 'org.matrix.cross_signing_reset';

/**
 * The account-level Trust module on top of the {@link TRUST_ENGINE}: sets up
 * cross-signing, secret storage (4S) and key backup, exposes readiness as signals, and
 * recovers a fresh device from the recovery key. Every decision and message stays here;
 * the engine runs the protocol steps.
 */
@Injectable({ providedIn: 'root' })
export class TrustService {
  private readonly providerRecovery = inject(TRUST_PROVIDER_RECOVERY);
  private readonly healthRuntime = inject(TrustHealthService);
  private readonly engine = inject(TRUST_ENGINE);
  private readonly session = inject(SessionStateService);

  /** Atomic Trust state; no caller can observe a status assembled across generations. */
  readonly health = this.healthRuntime.health;
  /** Compatibility projections for the existing Trust surfaces. */
  readonly status = this.healthRuntime.status;
  readonly keyBackupActive = this.healthRuntime.keyBackupActive;
  readonly thisDeviceVerified = this.healthRuntime.thisDeviceVerified;
  /** Verified here, but only the device holding the identity can set up recovery. */
  readonly recoverySetupElsewhere = this.healthRuntime.recoverySetupElsewhere;

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
   * First-device setup: create a recovery key, bootstrap cross-signing, secret storage
   * and a new key backup. Emits the encoded recovery key string for the user to save — it
   * is shown once and never persisted. Needs UIA (the user's password) to upload the new
   * device-signing keys.
   *
   * The key is generated randomly (no passphrase), so accounts onboarded here are
   * recovered via {@link recoverWithKey}, not {@link recoverWithPassphrase}.
   *
   * Two guards run first, both of which ask the server before trusting this device's view:
   * - {@link assertNoRecoveryOnAccount} refuses an account that already has a 4S key.
   *   It fails open: an unreachable server must not block genuine first-run setup.
   * - {@link assertNoIdentityElsewhere} refuses an account whose cross-signing identity
   *   this device does not hold, because bootstrapping here would replace it. It re-reads
   *   the published identity first, then checks the keys held locally against it. It fails
   *   closed: the upload that follows needs the same server, and a wrong "no identity"
   *   is the destructive answer.
   *
   * An account that cannot answer a password (SSO-only, OIDC-native) ends as
   * `provider-action-required`.
   *
   * When this device holds an identity the server never received (a first setup cancelled
   * or failed before its upload), setup creates and uploads new keys rather than storing
   * the unpublished ones in secret storage.
   */
  setUp(promptPassword: PasswordPrompt): Observable<string> {
    return defer(() => {
      // Captured once: an account switch mid-flight must not retarget the setup.
      const accountId = this.session.activeAccountId();
      if (!accountId) throw notReady('setup');
      return this.engine.serverDefaultKeyId(accountId).pipe(
        concatMap((server) => {
          assertNoRecoveryOnAccount(server);
          return this.engine.ownIdentityCheck(accountId);
        }),
        concatMap((check) => {
          if (!check.ok) throw commandRefusal('setup', check.failure);
          const identity = assertNoIdentityElsewhere(check.value);
          return answerPasswordPrompts(
            this.engine,
            accountId,
            // Keys this device made and never uploaded are replaced: the server has no
            // identity, so new keys replace nothing.
            this.engine.setUpRecovery(accountId, {
              newIdentity: identity === 'unpublished',
            }),
            promptPassword,
          );
        }),
        map((result) => {
          if (!result.ok) throw commandRefusal('setup', result.failure);
          return result.value.recoveryKey;
        }),
        concatMap((recoveryKey) =>
          from(this.healthRuntime.reconcile()).pipe(map(() => recoveryKey)),
        ),
      );
    }).pipe(recoverTrustOperation('setup'));
  }

  /**
   * Last resort: throw the account's encryption identity away and build a new one, for
   * someone who has lost their recovery key and has no other verified device.
   *
   * Emits the new recovery key, exactly as {@link setUp} does, so the same shown-once
   * display can present it. **This destroys data and cannot be undone** — see
   * {@link runRecoveryReset}, which owns the ordering that makes a refused reset free.
   */
  resetRecovery(promptPassword: PasswordPrompt): Observable<string> {
    return defer(() => {
      // Captured once: the reset spans several steps, and an account switch mid-flight
      // must not retarget the rollback (or the UIA user id) onto a different account.
      const accountId = this.session.activeAccountId();
      if (!accountId) throw notReady('reset-recovery');
      // Refused before the password is asked for when the account has no crypto.
      return this.engine.facts(accountId).pipe(
        take(1),
        concatMap((facts) => {
          if (!facts.ok && facts.failure.code !== 'request-failed') {
            throw commandRefusal('reset-recovery', facts.failure);
          }
          return runRecoveryReset(
            {
              engine: this.engine,
              accountId,
              refreshStatus: () => this.healthRuntime.reconcile(),
            },
            promptPassword,
          );
        }),
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

  /** Unlock this device from the account's recovery key. */
  recoverWithKey(recoveryKey: string): Observable<void> {
    return this.recover({ kind: 'recovery-key', value: recoveryKey });
  }

  /**
   * Unlock this device from a recovery passphrase. Only works for accounts whose 4S key
   * was derived from a passphrase; {@link setUp} provisions a random recovery key, so
   * Trinity-onboarded accounts use {@link recoverWithKey} instead.
   */
  recoverWithPassphrase(passphrase: string): Observable<void> {
    return this.recover({ kind: 'passphrase', value: passphrase });
  }

  /**
   * Export this device's Megolm room keys as a passphrase-encrypted file, in the
   * interoperable Matrix key-export format (the same `.txt` Element reads/writes). A safety
   * net independent of the server key backup.
   */
  exportRoomKeys(passphrase: string): Observable<string> {
    return this.onActiveAccount('export-keys', (accountId) =>
      this.engine.exportRoomKeys(accountId, passphrase),
    );
  }

  /**
   * Import Megolm room keys from a passphrase-encrypted export file. A wrong passphrase (or
   * a corrupted file) surfaces as an error rather than importing nothing.
   */
  importRoomKeys(armored: string, passphrase: string): Observable<void> {
    return this.onActiveAccount('import-keys', (accountId) =>
      this.engine.importRoomKeys(accountId, armored, passphrase),
    ).pipe(map(() => undefined));
  }

  /** Unlock 4S on the active account, so this device is trusted and backup is on. */
  private recover(secret: RecoverySecret): Observable<void> {
    return this.onActiveAccount('recover', (accountId) =>
      this.engine.recover(accountId, secret),
    ).pipe(concatMap(() => this.healthRuntime.reconcile()));
  }

  /** Runs one engine command on the account active now, failing with Trust's texts. */
  private onActiveAccount<T>(
    operation: TrustOperation,
    run: (accountId: string) => Observable<EngineResult<T>>,
  ): Observable<T> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) throw notReady(operation);
      return run(accountId);
    }).pipe(
      map((result) => {
        if (!result.ok) throw commandRefusal(operation, result.failure);
        return result.value;
      }),
      recoverTrustOperation(operation),
    );
  }
}

const notReady = (operation: TrustOperation) =>
  new TrustOperationError(
    operation,
    'not-ready',
    'retry',
    'Trust is not ready for this account yet.',
  );

function recoveryRefusal(
  operation: TrustOperation,
  reason: RecoveryRefusal,
): TrustOperationError {
  switch (reason) {
    case 'not-configured':
      return new TrustOperationError(
        operation,
        'recovery-not-configured',
        'verify-another-device',
        'No recovery key is set up on this account.',
      );
    case 'malformed-key':
      return new TrustOperationError(
        operation,
        'invalid-secret',
        'reenter-secret',
        'That does not look like a valid recovery key.',
      );
    case 'no-passphrase':
      return new TrustOperationError(
        operation,
        'unsupported',
        'reenter-secret',
        'This account has no recovery passphrase — enter the recovery key instead.',
      );
    case 'incorrect':
      return new TrustOperationError(
        operation,
        'invalid-secret',
        'reenter-secret',
        operation === 'import-keys'
          ? 'The key export or its passphrase could not be verified.'
          : 'That recovery key is incorrect.',
      );
  }
}

/** Trust's text for an engine refusal; anything else is classified by {@link trustOperationFailure}. */
function commandRefusal(
  operation: TrustOperation,
  failure: EngineFailure,
): Error {
  switch (failure.code) {
    case 'account-not-live':
    case 'crypto-not-ready':
      return notReady(operation);
    case 'recovery-refused':
      return recoveryRefusal(operation, failure.params.reason);
    default:
      return new EngineRequestError(failure);
  }
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
