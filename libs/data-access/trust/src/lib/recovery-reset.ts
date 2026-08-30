import { Method, retryNetworkOperation } from 'matrix-js-sdk';
import type { GeneratedSecretStorageKey } from 'matrix-js-sdk/lib/crypto-api';
import type { ServerSideSecretStorage } from 'matrix-js-sdk/lib/secret-storage';
import type {
  TrustCryptoApi,
  TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  completePasswordUia,
  isUiaRefusal,
  runPasswordUia,
  type PasswordPrompt,
} from '@trinity/util/matrix';

/**
 * How long any one of the reset's single homeserver round-trips may wait — an
 * account-data write, or the dehydrated-device delete.
 */
const ACCOUNT_DATA_TIMEOUT_MS = 10_000;

/**
 * How long the destructive tail may run before we stop waiting and say so.
 *
 * Deliberately far larger than {@link ACCOUNT_DATA_TIMEOUT_MS}: `bootstrapSecretStorage`
 * is ~6 echo-waiting account-data writes plus the backup deletions, and a /sync long-poll
 * that has died is not noticed for `pollTimeout` 30s + `BUFFER_PERIOD_MS` 80s
 * (sync.js:49,101,317). A budget under ~110s would abort a tail that the sync loop was
 * about to unblock on its own, and tell the user their reset half-failed when it did not.
 *
 * The trade-off in the other direction is accepted knowingly: a timeout here cannot undo
 * anything the tail already did. All it buys is a legible failure instead of a spinner
 * that never stops — which is why {@link PARTIAL_RESET_MESSAGE}, not "timed out", is what
 * the user is shown.
 */
const DESTRUCTIVE_TAIL_TIMEOUT_MS = 150_000;

/**
 * The rollback's one guaranteed write gets attempts and a budget of its own.
 *
 * Three attempts back off 2s then 4s (http-api/utils.js:119), so the budget has to clear
 * that with room for the requests themselves. It is only ever spent when the connection is
 * genuinely down — in which case the error the user is already being shown is the right
 * outcome, and a longer wait would buy nothing.
 */
const RESTORE_ATTEMPTS = 3;
const RESTORE_TIMEOUT_MS = 20_000;

/** What to tell the user when the destructive tail stops responding half-finished. */
const PARTIAL_RESET_MESSAGE =
  'The homeserver stopped responding while the reset was being finished, so it may have completed only partly. Check Settings → Security to see whether recovery is set up before starting another reset.';

/** The irreversible tail started, so callers must offer inspection rather than blind retry. */
export class PartialRecoveryResetError extends Error {
  override readonly name = 'PartialRecoveryResetError';

  constructor() {
    super(PARTIAL_RESET_MESSAGE);
  }
}

/** The account-data key every device reads to find the current 4S key. */
export const DEFAULT_KEY_EVENT = 'm.secret_storage.default_key';

/** Dehydrated devices (MSC3814) are still unstable-prefixed in Synapse and the SDK. */
const DEHYDRATED_DEVICE_PREFIX =
  '/_matrix/client/unstable/org.matrix.msc3814.v1';

/** Everything the reset touches, captured once by the caller. */
export interface RecoveryResetContext {
  readonly crypto: TrustCryptoApi;
  readonly client: TrustMatrixClient;
  readonly storage: ServerSideSecretStorage;
  readonly userId: string;
  /** Recompute the caller's status signals; must not reject. */
  readonly refreshStatus: () => Promise<void>;
}

/**
 * Throw the account's encryption identity away and build a new one, for someone who has
 * lost their recovery key and has no other verified device. Resolves with the new
 * recovery key, exactly as first-device setup does, so the same shown-once display can
 * present it.
 *
 * **This destroys data and cannot be undone.** Every key-backup version on the account
 * goes, not just this device's view of it, so the user's other devices lose the shared
 * backup too — they keep whatever message keys are already in their local stores, stay
 * signed in, and lose only cross-signing trust. Anything not already decryptable
 * somewhere is gone. Callers must say so before calling this.
 *
 * **It deliberately does not call `CryptoApi.resetEncryption`.** That method deletes every
 * key-backup version and all of secret storage *before* the cross-signing upload that
 * needs user-interactive auth — and the password prompt lives inside that upload. So a
 * cancelled prompt, a mistyped password, an SSO-only account or an OIDC-native homeserver
 * all destroyed the backup on the way to failing, and gave nothing back. Measured against
 * Synapse v1.119.0: `room_keys/version` went from 200 to `M_NOT_FOUND` while the UI
 * reported that the identity provider had to do it instead.
 *
 * The same steps in an order that authenticates first fix that:
 *
 * 1. Complete a real UIA round-trip against a request that does nothing (deleting an
 *    empty list of devices). A refusal — cancelled, SSO-only, out of attempts — ends the
 *    reset here, with zero writes and nothing rotated. That guarantee holds for every
 *    server that challenges this request; one that does not challenge it is covered by
 *    the rollback instead, and the note at the park says why.
 * 2. Park the 4S pointer, then rotate + upload the new identity, replaying the password
 *    the server already accepted.
 * 3. Only then destroy: the old dehydrated device, then every key-backup version, via
 *    `bootstrapSecretStorage({ setupNewKeyBackup: true })`.
 *
 * `setupNewKeyBackup` is REQUIRED here (unlike in the `resetEncryption` shape this
 * replaced, where passing it would have made a second backup): `resetKeyBackup` →
 * `setupKeyBackup` opens with `deleteAllKeyBackupVersions()`, so that one call *is* the
 * destructive tail — new 4S key, the new cross-signing privates and the new backup key
 * filed under it, old versions gone.
 *
 * We own a copy of the SDK's reset, so an extra step added to `resetEncryption` upstream
 * will not be inherited — the ordering unit test is what guards that. One step is
 * deliberately not where the SDK puts it: `resetEncryption` deletes the dehydrated device
 * first thing, which for us would destroy something before the user has authenticated, so
 * it runs at the head of the destructive tail instead.
 */
export async function runRecoveryReset(
  ctx: RecoveryResetContext,
  promptPassword: PasswordPrompt,
): Promise<string> {
  const { crypto, client, storage, userId } = ctx;

  // Authenticate BEFORE anything is parked or rotated. Deleting an empty list of devices
  // is a request whose own effect is nothing, but which the server gates with the same
  // password UIA as the key upload below — so this proves the user can answer it, rather
  // than only that the server offers it.
  const accepted = await preAuthenticate(client, promptPassword, userId);

  // Park the 4S pointer. `resetCrossSigning` exports the freshly rotated private keys
  // into the CURRENT 4S key before it uploads anything — but only when `hasKey()`, which
  // resolves through the default key id. This user cannot open that key, so leaving the
  // pointer in place makes the rotation die on a falsey key callback and never reach the
  // upload at all. `resetEncryption` creates the same precondition by deleting secret
  // storage outright; parking the pointer is the reversible version of that.
  //
  // It is still an account-wide write, and every other device reads it. Usually the
  // password is already accepted by the time it happens, so the window it is parked for
  // is a couple of HTTP round-trips rather than however long a human stares at a modal.
  // Two residuals span a prompt anyway, and `abandonReset` is what covers both:
  //
  //  - the upload rejects the replayed password, i.e. it changed between the two
  //    requests, so the user is asked again with the pointer already parked;
  //  - the server never challenged the pre-auth request at all, so `accepted` is null and
  //    the FIRST prompt the user sees is the upload's own — with the pointer parked and
  //    the local identity already rotated. Synapse gates `/delete_devices` with
  //    `can_skip_ui_auth=True`, and an MSC3861 deployment bypasses UIA there while
  //    `/keys/device_signing/upload` can still challenge, so this is reachable rather
  //    than theoretical. Forcing a challenge the server did not offer is not an option;
  //    a cancel here costs a rollback, not data.
  //
  // The park itself resolves only on the /sync echo, and its PUT goes out first — so an
  // unconfirmed park may still have landed account-wide. Bound it, and on anything but a
  // confirmed write put the pointer back and abort before a single key is rotated.
  const previousKeyId = await storage.getDefaultKeyId();
  if (previousKeyId) {
    try {
      await withTimeout(storage.setDefaultKeyId(null));
    } catch (err) {
      await abandonReset(ctx, previousKeyId);
      throw err;
    }
  }

  try {
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: true,
      // The upload has its own UIA session, so it is challenged again even though the
      // user just authenticated. Replaying the accepted password answers it without a
      // second prompt; only a rejection falls through to asking. That rejection is the
      // replay's, not the user's, so it gets its own attempt rather than one of theirs.
      authUploadDeviceSigningKeys: (makeRequest) =>
        runPasswordUia(
          makeRequest,
          replayAccepted(accepted, promptPassword),
          userId,
          { replayedAttempts: accepted === null ? 0 : 1 },
        ),
    });
  } catch (err) {
    await abandonReset(ctx, previousKeyId);
    throw err;
  }

  // Past the point of no return: the new identity is published. Failing from here cannot
  // be undone, but it must not also leave the UI describing an account that no longer
  // exists — so the status is recomputed either way.
  try {
    await deleteDehydratedDevice(client);
    const recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
    // The biggest writes of the whole reset, and the ones most able to hang: ~6
    // echo-waiting account-data writes (`addKey`, `setDefaultKeyId`, three
    // `m.cross_signing.*` stores) plus `deleteAllKeyBackupVersions`. Individual Matrix
    // requests have the client's 30-second deadline; this larger budget remains the only
    // backstop for the whole multi-request destructive sequence.
    await withTimeout(
      crypto.bootstrapSecretStorage({
        setupNewKeyBackup: true,
        createSecretStorageKey: async () => recoveryKey,
      }),
      DESTRUCTIVE_TAIL_TIMEOUT_MS,
      new PartialRecoveryResetError(),
    );
    await dropStaleKeyDescription(storage, previousKeyId);
    return encodedRecoveryKey(recoveryKey);
  } catch (cause) {
    // The identity is already published. Every failure from here is necessarily partial,
    // whether it is a timeout, key generation/encoding failure, or an ordinary SDK error.
    throw cause instanceof PartialRecoveryResetError
      ? cause
      : new PartialRecoveryResetError();
  } finally {
    await ctx.refreshStatus();
  }
}

/** The encoded recovery key to show the user, or a clear failure if there isn't one. */
export function encodedRecoveryKey(key: GeneratedSecretStorageKey): string {
  if (!key.encodedPrivateKey) {
    throw new Error('Failed to generate a recovery key.');
  }
  return key.encodedPrivateKey;
}

/**
 * Complete a password UIA round-trip against a harmless request and return the accepted
 * password (null if the server asked for none).
 *
 * A refusal — cancelled prompt, no password stage, out of attempts — propagates, and is
 * the whole point: it stops the reset while it is still free. Anything else is the probe
 * request itself failing, which must not become a new way for the reset to fail: a
 * dropped connection, or a server that gates `/delete_devices` differently from the key
 * upload, leaves the user exactly where they were, and the upload's own prompt still
 * asks.
 */
async function preAuthenticate(
  client: TrustMatrixClient,
  promptPassword: PasswordPrompt,
  userId: string,
): Promise<string | null> {
  try {
    return await completePasswordUia(
      (auth) => client.deleteMultipleDevices([], auth ?? undefined),
      promptPassword,
      userId,
    );
  } catch (err) {
    if (isUiaRefusal(err)) {
      throw err;
    }
    return null;
  }
}

/** A prompt that answers once from `accepted`, then defers to the user. */
function replayAccepted(
  accepted: string | null,
  promptPassword: PasswordPrompt,
): PasswordPrompt {
  let replay = accepted;
  return async () => {
    if (replay === null) {
      return promptPassword();
    }
    const password = replay;
    replay = null; // a rejected replay must reach the user, not loop
    return password;
  };
}

/**
 * Delete the dehydrated device, if the account has one. It is signed by the cross-signing
 * key this reset just replaced, so it can no longer be verified by anything.
 *
 * Not reachable through `CryptoApi` — `resetEncryption` calls the manager directly — so
 * this issues the same request. Best effort: a server without MSC3814 (`M_UNRECOGNIZED`)
 * or without a dehydrated device (`M_NOT_FOUND`) is the common case, and no failure here
 * is worth failing a reset that already succeeded.
 *
 * Bounded as well as swallowed. It heads the destructive tail and uses the crypto flow's
 * tighter limit rather than waiting for the account client's default request deadline.
 */
async function deleteDehydratedDevice(
  client: TrustMatrixClient,
): Promise<void> {
  try {
    await withTimeout(
      client.http.authedRequest(
        Method.Delete,
        '/dehydrated_device',
        undefined,
        {},
        { prefix: DEHYDRATED_DEVICE_PREFIX },
      ),
    );
  } catch {
    // nothing to delete, nothing we can do about it, or nothing answering
  }
}

/**
 * Undo the one reversible thing a failed reset did, and re-seat the account's real
 * cross-signing identity locally — the olm machine rotated its private keys before the
 * upload was authorised, so without a forced `/keys/query` this device would go on
 * believing in an identity the server has never seen.
 *
 * Best effort by construction: it must never replace the error that caused it. The two
 * repairs are independent, and get an attempt and a budget each — the pointer restore is
 * the one that can hang on a stalled sync, and it must not starve the cheap local one.
 *
 * Also used when the park itself does not confirm, where nothing has been rotated yet and
 * the key query is a harmless no-op; both repairs are idempotent, so one entry point.
 */
async function abandonReset(
  ctx: RecoveryResetContext,
  previousKeyId: string | null,
): Promise<void> {
  // `ctx` holds the caller's captures, not whatever account is active now — an account
  // switch mid-reset must not point the repair at the wrong one.
  await bestEffort(() => restoreDefaultKeyId(ctx, previousKeyId));
  await bestEffort(() =>
    withTimeout(ctx.crypto.userHasCrossSigningKeys(ctx.userId, true)),
  );
  await ctx.refreshStatus();
}

/**
 * Put the 4S pointer back on the SERVER, and this client's view of it back afterwards.
 *
 * Leaving it parked is worse than the failure that got us here: every device on the
 * account then reads "no recovery set up" and is offered a fresh one, which would mint a
 * new 4S key and orphan the user's still-valid one.
 *
 * **Guaranteed: the server.** `client.setAccountDataRaw` is a bare authed PUT that always
 * sends and resolves on the HTTP response (client.js:1319-1326), so it is *the* writer
 * here — unconditional, first, and the thing whose failure fails this repair. Its
 * resolution is also the confirmation, because there is nothing better to confirm against:
 * `getDefaultKeyId` routes through `getAccountDataFromServer`, which once initial sync is
 * complete answers from the LOCAL store (client.js:1346-1358). On exactly the failure this
 * repair exists for — the park's PUT landed, its /sync echo did not — that store still
 * holds the PRE-park value, so reading it back would "confirm" a server state that is in
 * fact wrong and skip the only write that fixes it. No read gates this write.
 *
 * `storage.setDefaultKeyId` cannot play that role either, for a second reason: its inner
 * `setAccountData` short-circuits to a no-op when the local store already deep-equals the
 * value (client.js:1287-1288), and its promise resolves only from its own
 * `ClientEvent.AccountData` listener (secret-storage.js:134-165) — so on that same failure
 * it sends nothing and then waits forever for an echo it never caused.
 *
 * **Best effort: this client's own view**, via {@link realignLocalPointer}, because
 * `status` is computed from that local store and a stale `needs-setup` puts a "set up
 * recovery" button — which mints a new 4S key and deletes the key backup — in front of the
 * user. Bounded, and never allowed to fail the repair. When it cannot run, the server is
 * still right for every other device, and `TrustService.setUp` refuses on a server read of
 * its own rather than trusting the local one.
 */
async function restoreDefaultKeyId(
  ctx: RecoveryResetContext,
  previousKeyId: string | null,
): Promise<void> {
  if (!previousKeyId) {
    return;
  }
  const { client, storage } = ctx;
  // Retried, because `setAccountDataRaw` is a bare request while the writer it replaced
  // reached the network through `retryNetworkOperation` inside `client.setAccountData`
  // (client.js:1307). Dropping that retry would matter most exactly where it is least
  // affordable: "the echo was lost" usually means the connection died, which is precisely
  // when the next PUT throws `ConnectionError` — so a single blip would lose the one write
  // the whole rollback exists to make. Hence its own, longer budget: three attempts back
  // off 2s then 4s, and this is the write that must land.
  await withTimeout(
    retryNetworkOperation(RESTORE_ATTEMPTS, () =>
      client.setAccountDataRaw(DEFAULT_KEY_EVENT, { key: previousKeyId }),
    ),
    RESTORE_TIMEOUT_MS,
  );
  await bestEffort(() => realignLocalPointer(storage, previousKeyId));
}

/**
 * Bring this client's local store back into line with the pointer just written, so
 * `status` stops reporting `needs-setup`.
 *
 * The read is a legitimate use of the local store — "is my own view stale?" is exactly
 * what it can answer — and not a proxy for the server, which the caller has already
 * settled. Skipping when it already agrees is what keeps this from hanging: on an agreeing
 * store `setDefaultKeyId` writes nothing and never resolves (client.js:1287-1288 +
 * secret-storage.js:134-165).
 *
 * When the store does disagree the write is real, and costs a second, identical PUT — the
 * price of a writer that also updates the local view. It still resolves only on the echo,
 * so it is bounded too: a sync that never comes back must cost a budget, not the error the
 * caller is carrying.
 */
async function realignLocalPointer(
  storage: ServerSideSecretStorage,
  keyId: string,
): Promise<void> {
  if ((await withTimeout(storage.getDefaultKeyId())) === keyId) {
    return;
  }
  await withTimeout(storage.setDefaultKeyId(keyId));
}

/**
 * The one bit of cleanup `bootstrapSecretStorage` does not do for us: drop the old key
 * description, which nothing points at once the new default key is in place. Best effort
 * — a stale description is inert, and failing here must not fail a completed reset.
 *
 * Bounded, because it is the last step after the destructive tail: `storage.store(…, null)`
 * short-circuits to `client.setAccountData`, which waits for the /sync echo, and a lost
 * echo would hang the reset *after* the new 4S key exists — leaving the user's only copy
 * of it undisplayed, with nothing to do but reset again.
 *
 * The *read* needs the same bound, for a reason that is easy to miss: `getDefaultKeyId`
 * answers from the local store only while `isInitialSyncComplete()` (client.js:1346-1358).
 * A stalled long-poll is abandoned after ~110s (sync.js) — inside the budget the tail above
 * is deliberately given — and from that moment this is a bare network GET. The local
 * timeout is tighter than the client's default; timing out here is harmless because it
 * lands in the same catch and an undropped description is inert.
 */
async function dropStaleKeyDescription(
  storage: ServerSideSecretStorage,
  previousKeyId: string | null,
): Promise<void> {
  if (!previousKeyId) {
    return;
  }
  try {
    if ((await withTimeout(storage.getDefaultKeyId())) === previousKeyId) {
      return; // the new key never landed; leave the old description alone
    }
    await withTimeout(
      storage.store(`m.secret_storage.key.${previousKeyId}`, null),
    );
  } catch {
    // inert leftover; not worth failing a completed reset
  }
}

/** Run a repair that must never replace the error the caller is already carrying. */
async function bestEffort(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // nothing better to do here; the caller's error is the one that matters
  }
}

/**
 * Await `work`, but not forever.
 *
 * Account-data writes resolve only when their echo returns over /sync, so a stopped or
 * stalled sync loop leaves them pending indefinitely — and the PUT they are waiting to
 * hear back about has already gone out. No account-data write in this file is survivable
 * unbounded: on the failure path the rollback sits between the user's cancellation and
 * the error they are waiting to be told about, and on the happy path the park sits before
 * the rotation and the description cleanup sits after the point of no return.
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
