import type { CrossSigningFacts, TrustFacts } from './trust-engine';
import type { TrustHealthSnapshot } from './trust-health.service';

/**
 * Trust's status policy over one read of an Account's facts, for any live Account (the
 * active-Account projection and the per-Account summaries share it).
 *
 * `needs-verification`: the Account has a cross-signing identity that another client
 * published, no secret storage, and this device neither holds the private keys nor is
 * verified. First-device setup there would replace the identity (bootstrap creates new keys
 * when none are available locally or in 4S), so it must be offered verification instead.
 *
 * `identityElsewhere` carries the same local check for a device that IS verified: one
 * verified through another device on an Account without 4S never receives the private
 * keys (matrix-js-sdk 43 does not request missing secrets after verification), so it
 * reads `needs-setup` while only the holding device can set up recovery.
 */
export function deriveTrustSnapshot(facts: TrustFacts): TrustHealthSnapshot {
  const ready = facts.crossSigningReady && facts.secretStorageReady;
  // Only where there is no recovery: with secret storage the privates are reachable
  // through the recovery key, and a ready device needs nothing.
  const identityElsewhere =
    !ready &&
    !facts.hasDefaultKey &&
    facts.crossSigning.publicKeysOnDevice &&
    !holdsCrossSigningIdentity(facts.crossSigning, facts.crossSigningReady);
  const status: TrustHealthSnapshot['status'] = ready
    ? 'ready'
    : facts.hasDefaultKey
      ? 'needs-recovery'
      : !facts.thisDeviceCrossSigned && identityElsewhere
        ? 'needs-verification'
        : 'needs-setup';
  return {
    keyBackupActive: facts.keyBackupActive,
    thisDeviceVerified: facts.thisDeviceCrossSigned,
    identityElsewhere,
    status,
  };
}

/**
 * Whether this device holds the Account's cross-signing identity: all three private keys
 * cached locally, and those keys matching the published identity.
 *
 * Holding three privates is not enough. `resetCrossSigning` rotates them in the olm
 * machine before it uploads anything, so a reset cancelled at the password prompt leaves
 * a device with a full set nobody published. Counting those as the identity would offer
 * setup here, and setup would then store the unpublished seeds in secret storage: a
 * recovery key that can never verify a device.
 *
 * `crossSigningReady` (`isCrossSigningReady()`) supplies the match. With the privates
 * cached it reduces to `identity.isVerified()`, the same test `getCrossSigningKeyId` uses
 * to detect "both public and private keys, but they don't match". It is not enough on its
 * own: until the next own-key query, the olm machine keeps the rotated identity it created
 * locally and marks it verified, so stranded privates can still read as held. The query
 * itself closes that window: matrix-sdk-crypto replaces the local identity with the
 * published one and clears private keys that differ from it. `assertNoIdentityElsewhere`
 * therefore judges it on `ownIdentityCheck`, which asks the server first, and `abandonReset`
 * re-queries for the same reason. `hasStrandedCrossSigning` relies on the same distinction.
 */
export function holdsCrossSigningIdentity(
  status: Pick<CrossSigningFacts, 'privateKeysCachedLocally'>,
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
