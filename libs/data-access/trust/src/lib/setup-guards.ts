import { Method } from 'matrix-js-sdk';
import type {
  TrustCryptoApi,
  TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import { DEFAULT_KEY_EVENT, withTimeout } from './recovery-reset';
import { TrustOperationError } from './trust-operation-error';
import {
  holdsCrossSigningIdentity,
  readPublishedMasterKey,
  readThisDeviceVerified,
} from './trust-snapshot';

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
 * is exactly the window a rolled-back recovery reset opens, so the local view cannot be
 * the check here. Ask the server.
 *
 * **Fails open on purpose.** Only a pointer the server positively reports stops the setup;
 * an unreachable or unhappy server does not. This exists to block a known-destructive
 * action, not to become a new way for genuine first-run setup to fail.
 *
 * `ownKey` is the key an earlier, partly failed setup on this device minted and showed.
 * When the server's pointer is that key, finishing the setup replaces nothing the user
 * does not already hold.
 *
 * Resolves with what it found, so setup can tell whether a key it mints may become the
 * account's: `none`, `unreadable` (failed open), or the id of `ownKey`.
 */
export async function assertNoRecoveryOnAccount(
  client: TrustMatrixClient,
  ownKey: Uint8Array | null = null,
): Promise<'none' | 'unreadable' | { readonly ownKeyId: string }> {
  const keyId = await readServerDefaultKeyId(client);
  if (keyId === null || keyId === undefined) {
    return keyId === null ? 'none' : 'unreadable';
  }
  if (ownKey && (await isKeyFor(client, keyId, ownKey))) {
    return { ownKeyId: keyId };
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
type SetupIdentity = 'none' | 'unpublished' | 'held';

/**
 * Refuse first-device setup on an Account whose cross-signing identity lives elsewhere.
 *
 * With no private keys on this device and none in secret storage, `bootstrapCrossSigning`
 * "creat[es] new keys": the identity is replaced, every other device of the user stops
 * being cross-signed (and, under MSC4153, stops receiving room keys from strict senders),
 * and contacts who verified the user see an identity change. Resetting is a separate,
 * explicitly confirmed action (`resetRecovery`).
 *
 * **Fails closed**, unlike {@link assertNoRecoveryOnAccount}: the upload that follows
 * needs the same homeserver, and a wrong "no identity" here is the destructive answer.
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
export async function assertNoIdentityElsewhere(
  client: Pick<
    TrustMatrixClient,
    'downloadKeysForUsers' | 'getDeviceId' | 'getUserId'
  >,
  crypto: TrustCryptoApi,
): Promise<SetupIdentity> {
  // The local view can lag right after sign-in; ask the homeserver (own user). Asked
  // first because, for the own user, this also re-queries the published identity, so the
  // match below is judged against the server's copy.
  if (!(await withTimeout(crypto.userHasCrossSigningKeys(undefined, true)))) {
    return 'none';
  }
  // That answer comes from the olm machine, which keeps an identity it created even when
  // the query returns no master key. Only the server can say whether it was ever published.
  const published = await readPublishedMasterKey(client);
  const [status, crossSigningReady] = await Promise.all([
    crypto.getCrossSigningStatus(),
    crypto.isCrossSigningReady(),
  ]);
  const holds = holdsCrossSigningIdentity(status, crossSigningReady);
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
  if (holds && (await crypto.getCrossSigningKeyId()) === published) {
    // This device holds the published identity: bootstrap keeps it and only adds recovery.
    return 'held';
  }
  const verified = await readThisDeviceVerified(client, crypto).catch(
    () => false,
  );
  throw verified
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

/** Whether `privateKey` opens the account's current default 4S key, as this device sees it. */
export async function isDefaultKey(
  client: TrustMatrixClient,
  privateKey: Uint8Array,
): Promise<boolean> {
  try {
    const keyId = await client.secretStorage.getDefaultKeyId();
    return !!keyId && (await isKeyFor(client, keyId, privateKey));
  } catch {
    return false;
  }
}

/** Whether `privateKey` opens the 4S key `keyId`; any failed read is a no. */
async function isKeyFor(
  client: TrustMatrixClient,
  keyId: string,
  privateKey: Uint8Array,
): Promise<boolean> {
  try {
    const stored = await client.secretStorage.getKey(keyId);
    // checkKey answers true for a description with no MAC, which proves nothing.
    return (
      !!stored?.[1].mac &&
      (await client.secretStorage.checkKey(privateKey, stored[1]))
    );
  } catch {
    return false;
  }
}

/**
 * The account's 4S pointer as the SERVER has it, null when there is none, or undefined
 * when the read failed (the caller fails open either way).
 */
async function readServerDefaultKeyId(
  client: TrustMatrixClient,
): Promise<string | null | undefined> {
  const userId = client.getUserId();
  if (!userId) {
    return undefined;
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
  } catch (err) {
    // `M_NOT_FOUND` is the ordinary first-run answer; anything else (offline, 5xx, a
    // homeserver that stopped answering) is a read we cannot trust either way. Both
    // mean "let the setup proceed".
    return (err as { errcode?: unknown } | null)?.errcode === 'M_NOT_FOUND'
      ? null
      : undefined;
  }
}
