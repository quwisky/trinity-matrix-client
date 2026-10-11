import type {
  TrustCryptoApi,
  TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import type { TrustHealthSnapshot } from './trust-health.service';

/**
 * One coherent read of an Account's authoritative crypto state, usable for any live
 * Account (the active-Account projection and the per-Account summaries share it).
 *
 * `needs-verification` is the state `needs-setup` used to hide: the Account has a
 * cross-signing identity that another client published, no secret storage, and this
 * device neither holds the private keys nor is verified. First-device setup there would
 * replace the identity (`CrossSigningIdentity.ts:119-123` creates new keys when none are
 * available locally or in 4S), so it must be offered verification instead.
 */
export async function readTrustSnapshot(
  client: TrustMatrixClient,
  crypto: TrustCryptoApi,
): Promise<TrustHealthSnapshot> {
  const [crossSigningReady, secretStorageReady, backupVersion, defaultKeyId] =
    await Promise.all([
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
  const thisDeviceVerified = deviceStatus?.crossSigningVerified ?? false;
  const status: TrustHealthSnapshot['status'] =
    crossSigningReady && secretStorageReady
      ? 'ready'
      : defaultKeyId
        ? 'needs-recovery'
        : !thisDeviceVerified && (await identityHeldElsewhere(crypto))
          ? 'needs-verification'
          : 'needs-setup';
  return {
    keyBackupActive: backupVersion !== null,
    thisDeviceVerified,
    status,
  };
}

/**
 * Whether the Account has a published identity whose private keys this device does not
 * hold. A purely local read: right after sign-in the own identity may not have been
 * downloaded yet, so destructive callers must also ask the server (see `TrustService.setUp`).
 */
export async function identityHeldElsewhere(
  crypto: Pick<TrustCryptoApi, 'getCrossSigningStatus'>,
): Promise<boolean> {
  const status = await crypto.getCrossSigningStatus();
  return status.publicKeysOnDevice && !holdsAllCrossSigningPrivates(status);
}

/** Whether the olm machine caches all three cross-signing private keys locally. */
export function holdsAllCrossSigningPrivates(
  status: Awaited<ReturnType<TrustCryptoApi['getCrossSigningStatus']>>,
): boolean {
  const cached = status.privateKeysCachedLocally;
  return cached.masterKey && cached.selfSigningKey && cached.userSigningKey;
}
