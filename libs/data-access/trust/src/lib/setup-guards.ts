import type { EngineResult } from '@trinity/util/matrix';
import type { OwnIdentityCheck } from './trust-engine';
import { TrustOperationError } from './trust-operation-error';
import { holdsCrossSigningIdentity } from './trust-snapshot';

/**
 * Refuse first-device setup on an account that already has a 4S key.
 *
 * {@link TrustService.setUp} is one click away from every `needs-setup` surface, and on
 * an account that is already set up it is destructive rather than idempotent:
 * `bootstrapSecretStorage({ setupNewKeyBackup: true })` mints a fresh 4S key — orphaning
 * the still-valid one the user holds — and `resetKeyBackup` opens by deleting every
 * key-backup version on the account.
 *
 * `needs-setup` is derived from the LOCAL pointer (`TrustFacts.hasDefaultKey`), which goes
 * stale for as long as a /sync echo is missing — up to the ~110s the sync loop takes to
 * notice a dead long-poll. That is exactly the window a rolled-back recovery reset opens,
 * so the local view cannot be the check here. `server` is the SERVER's pointer
 * ({@link TrustEngine.serverDefaultKeyId}).
 *
 * **Fails open on purpose.** Only a pointer the server positively reports stops the setup;
 * an unreachable or unhappy server (a failed read) does not. This exists to block a
 * known-destructive action, not to become a new way for genuine first-run setup to fail.
 */
export function assertNoRecoveryOnAccount(
  server: EngineResult<string | null>,
): void {
  if (!server.ok || !server.value) {
    return;
  }
  throw new TrustOperationError(
    'setup',
    'stale-state',
    'review-security-settings',
    'This account already has a recovery key. Unlock this device with that key instead — setting up a new one here would replace it and delete the account’s key backup.',
  );
}

const IDENTITY_ELSEWHERE_MESSAGE =
  'This account already has encryption set up on another device. Verify this device with that device instead, or reset your identity if you can’t.';

/** Already verified with that device, so "verify with it" would send the user in a circle. */
const RECOVERY_ELSEWHERE_MESSAGE =
  'This account already has encryption set up on another device. Set up recovery on that device instead, or reset your identity if you can’t.';

/**
 * The Account's cross-signing identity as first-device setup finds it:
 * - `none`: neither the server nor this device has one, so bootstrap creates it;
 * - `unpublished`: this device created one the server never received, so setup must
 *   create and upload new keys (nothing exists on the server to replace);
 * - `held`: the server publishes one and this device holds its private keys.
 *
 * Both non-`none` answers need this device to hold an identity's private keys, and `held`
 * needs the server's key to be exactly that identity. The device's two reads (its own view,
 * then the raw `/keys/query`) can disagree with a lagging server; neither disagreement may
 * end in creating keys over an identity the server has or had.
 */
export type SetupIdentity = 'none' | 'unpublished' | 'held';

/**
 * Refuse first-device setup on an Account whose cross-signing identity lives elsewhere,
 * judged on {@link TrustEngine.ownIdentityCheck}, which re-reads the published identity
 * from the server before the local reads.
 *
 * With no private keys on this device and none in secret storage, `bootstrapCrossSigning`
 * "creat[es] new keys": the identity is replaced, every other device of the user stops
 * being cross-signed (and, under MSC4153, stops receiving room keys from strict senders),
 * and contacts who verified the user see an identity change. Resetting is a separate,
 * explicitly confirmed action (`resetRecovery`).
 *
 * **Fails closed**, unlike {@link assertNoRecoveryOnAccount}: the upload that follows
 * needs the same homeserver, and a wrong "no identity" here is the destructive answer. A
 * failed identity check is the caller's to refuse on; this only judges a successful one.
 *
 * Privates on this device count only when they match the published identity (see
 * {@link holdsCrossSigningIdentity}): a reset cancelled before its upload leaves a full
 * set nobody published, and setting up from there would store those in secret storage.
 *
 * The copy depends on whether this device is already verified: a device verified through
 * the other one still lacks the private keys when the Account has no 4S (matrix-js-sdk 43
 * does not request missing secrets after verification), so only that device can set up
 * recovery. The verification read only picks the sentence; if it fails, setup is still
 * refused, with the unverified device's copy.
 */
export function assertNoIdentityElsewhere(
  check: OwnIdentityCheck,
): SetupIdentity {
  // The local view can lag right after sign-in; the check re-queried the homeserver (own
  // user) first, so the match below is judged against the server's copy.
  if (!check.identityKnown) {
    return 'none';
  }
  // That answer comes from the olm machine, which keeps an identity it created even when
  // the query returns no master key. Only the server can say whether it was ever published.
  const published = check.publishedMasterKey;
  const { facts } = check;
  const holds = holdsCrossSigningIdentity(
    facts.crossSigning,
    facts.crossSigningReady,
  );
  if (!published) {
    // Replacing is safe only for this device's own unpublished identity. Without its keys
    // here, the two reads disagree: the first saw an identity the second missed. Refuse
    // rather than create keys over one the server may still have.
    if (holds) return 'unpublished';
    throw new TrustOperationError(
      'setup',
      'server-failure',
      'retry',
      'The homeserver could not confirm this account’s encryption identity. Try again.',
    );
  }
  if (holds && check.localMasterKey === published) {
    // This device holds the published identity: bootstrap keeps it and only adds recovery.
    return 'held';
  }
  throw facts.thisDeviceCrossSigned
    ? new TrustOperationError(
        'setup',
        'stale-state',
        'review-security-settings',
        RECOVERY_ELSEWHERE_MESSAGE,
      )
    : new TrustOperationError(
        'setup',
        'stale-state',
        'verify-another-device',
        IDENTITY_ELSEWHERE_MESSAGE,
      );
}
