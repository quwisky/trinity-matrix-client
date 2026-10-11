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
 *
 * `identityElsewhere` carries the same local check for a device that IS verified: one
 * verified through another device on an Account without 4S never receives the private
 * keys (matrix-js-sdk 43 does not request missing secrets after verification), so it
 * reads `needs-setup` while only the holding device can set up recovery.
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
  const thisDeviceVerified = await readThisDeviceVerified(client, crypto);
  const ready = crossSigningReady && secretStorageReady;
  // Only asked where there is no recovery: with secret storage the privates are
  // reachable through the recovery key, and a ready device needs nothing.
  const identityElsewhere =
    !ready &&
    !defaultKeyId &&
    (await identityHeldElsewhere(crypto, crossSigningReady));
  const status: TrustHealthSnapshot['status'] = ready
    ? 'ready'
    : defaultKeyId
      ? 'needs-recovery'
      : !thisDeviceVerified && identityElsewhere
        ? 'needs-verification'
        : 'needs-setup';
  return {
    keyBackupActive: backupVersion !== null,
    thisDeviceVerified,
    identityElsewhere,
    status,
  };
}

/** Whether this device is cross-signed by its own Account's identity. */
export async function readThisDeviceVerified(
  client: Pick<TrustMatrixClient, 'getDeviceId' | 'getUserId'>,
  crypto: Pick<TrustCryptoApi, 'getDeviceVerificationStatus'>,
): Promise<boolean> {
  const deviceId = client.getDeviceId();
  const userId = client.getUserId();
  const deviceStatus =
    userId && deviceId
      ? await crypto.getDeviceVerificationStatus(userId, deviceId)
      : null;
  return deviceStatus?.crossSigningVerified ?? false;
}

/**
 * Whether the Account has a published identity whose private keys this device does not
 * hold. A purely local read: right after sign-in the own identity may not have been
 * downloaded yet, so destructive callers must also ask the server (see `TrustService.setUp`).
 *
 * `crossSigningReady` is this device's `isCrossSigningReady()`, passed in because the
 * snapshot has already read it.
 */
export async function identityHeldElsewhere(
  crypto: Pick<TrustCryptoApi, 'getCrossSigningStatus'>,
  crossSigningReady: boolean,
): Promise<boolean> {
  const status = await crypto.getCrossSigningStatus();
  return (
    status.publicKeysOnDevice &&
    !holdsCrossSigningIdentity(status, crossSigningReady)
  );
}

/**
 * Whether this device holds the Account's cross-signing identity: all three private keys
 * cached locally, and those keys matching the published identity.
 *
 * Holding three privates is not enough. `resetCrossSigning` rotates them in the olm
 * machine before it uploads anything (CrossSigningIdentity.ts:139-167), so a reset
 * cancelled at the password prompt leaves a device with a full set nobody published.
 * Counting those as the identity would offer setup here, and setup would then store the
 * unpublished seeds in secret storage: a recovery key that can never verify a device.
 *
 * `crossSigningReady` (`isCrossSigningReady()`) supplies the match. With the privates
 * cached it reduces to `identity.isVerified()` (rust-crypto.ts:802-814), the same test
 * `getCrossSigningKeyId` uses to detect "both public and private keys, but they don't
 * match" (rust-crypto.ts:837-839). The own identity only verifies against the privates
 * that signed it, so stranded privates read false and a completed setup reads true.
 * `hasStrandedCrossSigning` (cross-signing-repair.ts) relies on the same distinction.
 */
export function holdsCrossSigningIdentity(
  status: Awaited<ReturnType<TrustCryptoApi['getCrossSigningStatus']>>,
  crossSigningReady: boolean,
): boolean {
  const cached = status.privateKeysCachedLocally;
  return (
    crossSigningReady &&
    cached.masterKey &&
    cached.selfSigningKey &&
    cached.userSigningKey
  );
}
