import type { MatrixClient } from 'matrix-js-sdk';
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api';

/** How long one crypto-flow homeserver round trip may wait. */
const ACCOUNT_DATA_TIMEOUT_MS = 10_000;

/** The account-data key every device reads to find the current 4S key. */
export const DEFAULT_KEY_EVENT = 'm.secret_storage.default_key';

/**
 * Await `work`, but not forever.
 *
 * Account-data writes resolve only when their echo returns over /sync, so a stalled sync
 * loop leaves them pending indefinitely, though the PUT they wait on has already gone out.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms = ACCOUNT_DATA_TIMEOUT_MS,
  failure: string | Error = 'Timed out waiting for the homeserver.',
): Promise<T> {
  // The loser of the race stays pending; without this its later rejection would surface
  // as an unhandled one.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(typeof failure === 'string' ? new Error(failure) : failure),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Account's cross-signing master key as the homeserver publishes it (`/keys/query`),
 * or null when the server has none. Throws when the server cannot be asked.
 *
 * The device's own view cannot answer this. A first setup cancelled before its upload
 * leaves the olm machine holding an identity it created and marked verified, and a key
 * query that returns no master key does not remove it, so `userHasCrossSigningKeys`,
 * `getCrossSigningStatus` and `isCrossSigningReady` all report that identity.
 */
export async function readPublishedMasterKey(
  client: Pick<MatrixClient, 'downloadKeysForUsers' | 'getUserId'>,
): Promise<string | null> {
  const userId = client.getUserId();
  if (!userId) {
    throw new Error('No signed-in user to query cross-signing keys for.');
  }
  const response = await withTimeout(client.downloadKeysForUsers([userId]));
  const keys = response.master_keys?.[userId]?.keys;
  return (keys && Object.values(keys)[0]) || null;
}

/** Whether this device is cross-signed by its own Account's identity. */
export async function readThisDeviceVerified(
  client: Pick<MatrixClient, 'getDeviceId' | 'getUserId'>,
  crypto: Pick<CryptoApi, 'getDeviceVerificationStatus'>,
): Promise<boolean> {
  const deviceId = client.getDeviceId();
  const userId = client.getUserId();
  const deviceStatus =
    userId && deviceId
      ? await crypto.getDeviceVerificationStatus(userId, deviceId)
      : null;
  return deviceStatus?.crossSigningVerified ?? false;
}
