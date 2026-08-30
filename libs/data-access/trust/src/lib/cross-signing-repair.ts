import type { ServerSideSecretStorage } from 'matrix-js-sdk/lib/secret-storage';
import type { TrustCryptoApi } from '@trinity/data-access/matrix-client';

/**
 * The cross-signing seeds, keyed by their field name in the SDK's secrets bundle and
 * valued by the 4S account-data name holding the same seed. Both sides are unpadded
 * base64 of the raw seed, so a value moves from one to the other unchanged.
 */
const CROSS_SIGNING_SEEDS = {
  master_key: 'm.cross_signing.master',
  self_signing_key: 'm.cross_signing.self_signing',
  user_signing_key: 'm.cross_signing.user_signing',
} as const;

type SeedField = keyof typeof CROSS_SIGNING_SEEDS;

/**
 * Whether this device is in the specific state {@link repairStaleCrossSigning} fixes:
 * holding all three cross-signing privates locally, with a different set of them in 4S,
 * and an own identity that still does not verify.
 *
 * `isCrossSigningReady()` alone is far too wide a trigger. It is
 * `!!identity?.isVerified() && (cachedLocally || inSecretStorage)` (rust-crypto.js:600),
 * so it is false for every unverified device — including the ordinary one that has simply
 * never imported anything, where there is nothing stale to evict and the SDK's own import
 * is what should run. Requiring the privates to be cached locally *as well* is what
 * distinguishes "the olm machine already holds keys nobody published" from "the olm
 * machine holds nothing yet".
 */
export async function hasStrandedCrossSigning(
  crypto: TrustCryptoApi,
): Promise<boolean> {
  const { privateKeysCachedLocally: cached, privateKeysInSecretStorage } =
    await crypto.getCrossSigningStatus();
  return (
    cached.masterKey &&
    cached.selfSigningKey &&
    cached.userSigningKey &&
    privateKeysInSecretStorage &&
    !(await crypto.isCrossSigningReady())
  );
}

/**
 * Evict cross-signing private keys the olm machine rotated for a reset that never
 * completed, and put the account's real ones back.
 *
 * `resetCrossSigning` rotates the privates locally *before* it uploads anything, so a
 * reset abandoned between the two leaves this device holding keys nobody published. That
 * state is self-sustaining: `bootstrapCrossSigning({})` sees privates already in the olm
 * machine and logs "doing nothing", so unlocking 4S later never replaces them and the
 * device stays untrusted forever. `importSecretsBundle` is the only public way to
 * overwrite them.
 *
 * Call this only when 4S is already unlocked (so the real seeds are readable) and
 * {@link hasStrandedCrossSigning} says this is that state.
 *
 * Loud on purpose. The bundle's field names come from the WASM crate's serde
 * representation, which no TypeScript type pins down (`to_json()` is `unknown`), so the
 * shape is probed at runtime — and a probe that fails means the repair silently would not
 * have worked. The user is waiting on this recovery; a legible failure beats a device
 * that reports success and stays broken.
 */
export async function repairStaleCrossSigning(
  crypto: TrustCryptoApi,
  storage: ServerSideSecretStorage,
  deviceId: string | null,
): Promise<void> {
  const seeds = await readSeedsFromSecretStorage(storage);
  if (!seeds) {
    // No cross-signing in 4S at all, so there is nothing stale to replace it with.
    return;
  }
  if (!crypto.exportSecretsBundle || !crypto.importSecretsBundle) {
    throw new Error(
      'This device holds cross-signing keys from an interrupted reset, and this version of matrix-js-sdk offers no way to replace them (SecretsBundle import/export is missing).',
    );
  }

  const bundle = await crypto.exportSecretsBundle();
  await crypto.importSecretsBundle(patchedBundle(bundle, seeds));

  if (deviceId) {
    // The privates are the account's again, but this device is signed by the ones that
    // were just evicted — the same signature `bootstrapCrossSigning` would have uploaded.
    await crypto.crossSignDevice(deviceId);
  }
}

/** The three seeds, or null unless 4S holds all of them. */
async function readSeedsFromSecretStorage(
  storage: ServerSideSecretStorage,
): Promise<Record<SeedField, string> | null> {
  const [master, selfSigning, userSigning] = await Promise.all([
    storage.get(CROSS_SIGNING_SEEDS.master_key),
    storage.get(CROSS_SIGNING_SEEDS.self_signing_key),
    storage.get(CROSS_SIGNING_SEEDS.user_signing_key),
  ]);
  if (!master || !selfSigning || !userSigning) {
    return null;
  }
  return {
    master_key: master,
    self_signing_key: selfSigning,
    user_signing_key: userSigning,
  };
}

/**
 * The exported bundle with its three cross-signing seeds replaced, leaving everything
 * else (the backup key and version) as the SDK wrote it.
 *
 * Rejects any shape but the one this was written against, rather than hand-building a
 * bundle from a guess at the field names.
 */
function patchedBundle(
  bundle: unknown,
  seeds: Record<SeedField, string>,
): Record<string, unknown> {
  const crossSigning = isRecord(bundle) ? bundle['cross_signing'] : undefined;
  const fields = Object.keys(CROSS_SIGNING_SEEDS) as SeedField[];
  if (
    !isRecord(bundle) ||
    !isRecord(crossSigning) ||
    fields.some((field) => typeof crossSigning[field] !== 'string')
  ) {
    throw new Error(
      `Cannot repair the cross-signing keys: matrix-js-sdk exported a secrets bundle in an unrecognised shape (expected a cross_signing object with ${fields.join(', ')}).`,
    );
  }
  return { ...bundle, cross_signing: { ...crossSigning, ...seeds } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
