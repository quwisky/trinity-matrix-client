import {
  type Observable,
  firstValueFrom,
  lastValueFrom,
  throwError,
  timeout,
} from 'rxjs';
import {
  EngineRequestError,
  type EngineFailureCode,
  type EngineResult,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import { answerPasswordPrompts } from './password-prompts';
import type { TrustEngine } from './trust-engine';

/** How long one of the reset's single steps may wait: the dehydrated-device delete or the key drop. */
const STEP_TIMEOUT_MS = 10_000;

/**
 * How long the destructive tail may run before we stop waiting and say so.
 *
 * Far larger than {@link STEP_TIMEOUT_MS}: creating the new 4S key and backup is ~6
 * echo-waiting account-data writes plus the backup deletions, and a /sync long-poll that
 * has died is not noticed for `pollTimeout` 30s + `BUFFER_PERIOD_MS` 80s. A budget under
 * ~110s would abort a tail the sync loop was about to unblock on its own, and tell the user
 * their reset half-failed when it did not.
 *
 * A timeout cannot undo anything the tail already did. It only buys a legible failure
 * instead of a spinner that never stops, which is why {@link PARTIAL_RESET_MESSAGE}, not
 * "timed out", is what the user is shown.
 */
const DESTRUCTIVE_TAIL_TIMEOUT_MS = 150_000;

/**
 * The park, and each repair of the rollback, gets a budget of its own: a pointer read and
 * an echo-waiting write. The pointer restore's three attempts back off 2s then 4s, so the
 * budget clears that with room for the requests.
 */
const REPAIR_TIMEOUT_MS = 20_000;
/** Above an engine's own park worst case (10 s read + 10 s write), so a write it sent always reports back. */
const PARK_TIMEOUT_MS = 30_000;

/** The pre-authentication outcomes that mean the person did not get in, which stop the reset. */
const UIA_REFUSALS: readonly EngineFailureCode[] = [
  'uia-cancelled',
  'uia-unsupported',
  'uia-attempts-exceeded',
];

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

/** What the reset runs on, captured once by the caller. */
export interface RecoveryResetContext {
  readonly engine: TrustEngine;
  /** The account the reset started on; an account switch mid-reset must not retarget it. */
  readonly accountId: string;
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
 * **It deliberately does not use the SDK's own reset.** js `resetEncryption` deletes every
 * key-backup version and all of secret storage *before* the cross-signing upload that
 * needs user-interactive auth — and the password prompt lives inside that upload. So a
 * cancelled prompt, a mistyped password, an SSO-only account or an OIDC-native homeserver
 * all destroy the backup on the way to failing, and give nothing back.
 *
 * The same steps run here in an order that authenticates first:
 *
 * 1. Complete a real UIA round-trip against a request that does nothing (deleting an
 *    empty list of devices). A refusal — cancelled, SSO-only, out of attempts — ends the
 *    reset here, with zero writes and nothing rotated. That guarantee holds for every
 *    server that challenges this request; one that does not challenge it is covered by
 *    the rollback instead, and the note at the park says why.
 * 2. Park the 4S pointer, then rotate + upload the new identity, replaying the password
 *    the server already accepted.
 * 3. Only then destroy: the old dehydrated device, then every key-backup version.
 *
 * {@link TrustEngine.createRecoveryAndBackup} *is* the destructive tail: a new 4S key, the
 * new cross-signing privates and the new backup key filed under it, old versions gone.
 *
 * Trust owns the order over the engine's steps, so an engine never runs a combined reset
 * (js `resetEncryption`, Rust `reset_identity`) and a step added to one upstream is not
 * inherited; the ordering spec, run on the fake engine, guards that. The dehydrated-device delete is
 * deliberately not first, where the SDK puts it: that would destroy something before the
 * user has authenticated, so it runs at the head of the destructive tail.
 */
export async function runRecoveryReset(
  ctx: RecoveryResetContext,
  promptPassword: PasswordPrompt,
): Promise<string> {
  const { engine, accountId } = ctx;

  // Authenticate BEFORE anything is parked or rotated. Deleting an empty list of devices
  // does nothing itself but is gated by the same password UIA as the key upload below, so
  // this proves the user can answer it, rather than only that the server offers it.
  const accepted = await preAuthenticate(ctx, promptPassword);

  // Park the 4S pointer. js `resetCrossSigning` exports the freshly rotated private keys
  // into the CURRENT 4S key before it uploads anything, but only when `hasKey()`, which
  // resolves through the default key id. This user cannot open that key, so leaving the
  // pointer in place makes the rotation die on a falsey key callback before the upload.
  // Parking the pointer is the reversible version of deleting secret storage outright.
  //
  // It is still an account-wide write, and every other device reads it. Usually the
  // password is already accepted, so it stays parked for a couple of HTTP round-trips
  // rather than however long a human stares at a modal. Two residuals span a prompt
  // anyway, and `abandonReset` covers both:
  //
  //  - the upload rejects the replayed password (it changed between the two requests), so
  //    the user is asked again with the pointer already parked;
  //  - the server never challenged the pre-auth request, so `accepted` is null and the
  //    FIRST prompt the user sees is the upload's own, with the pointer parked and the
  //    local identity already rotated. Synapse gates `/delete_devices` with
  //    `can_skip_ui_auth=True`, and an MSC3861 deployment bypasses UIA there while
  //    `/keys/device_signing/upload` can still challenge, so this is reachable. Forcing a
  //    challenge the server did not offer is not an option; a cancel here costs a
  //    rollback, not data.
  //
  // An unconfirmed park may still have landed account-wide (its PUT goes out before the
  // echo it waits on), so on anything but a confirmed write put the pointer back and abort
  // before a single key is rotated. The step reads the local pointer and skips the write
  // when there is nothing to park.
  // A failed park wrote nothing (the step's contract), so there is nothing to put back.
  // The bound only stops an engine that never answers from hanging the reset.
  const park = await valueOf(
    engine.setDefaultKeyPointer(accountId, null, 'confirmed'),
    PARK_TIMEOUT_MS,
  );
  const previousKeyId = park.previous;
  if (!park.confirmed) {
    await abandonReset(ctx, previousKeyId);
    throw new Error('The secret-storage pointer could not be parked.');
  }

  try {
    // The upload has its own UIA session, so it is challenged again. The engine replays the
    // accepted password into it without a second prompt; only a rejection falls through to
    // asking, and that rejection is the replay's, so it is not one of the user's attempts.
    const rotated = await lastValueFrom(
      answerPasswordPrompts(
        engine,
        accountId,
        engine.rotateCrossSigning(accountId, accepted),
        promptPassword,
      ),
    );
    if (!rotated.ok) throw new EngineRequestError(rotated.failure);
  } catch (err) {
    await abandonReset(ctx, previousKeyId);
    throw err;
  }

  // Past the point of no return: the new identity is published. Failing from here cannot
  // be undone, but it must not also leave the UI describing an account that no longer
  // exists — so the status is recomputed either way.
  try {
    // The dehydrated device is signed by the identity just replaced, so nothing can verify
    // it any more. Best effort: most servers have none, or no MSC3814 at all. It heads the
    // tail, not the reset (where the SDK puts it), so nothing goes before authentication.
    await bestEffort(() =>
      valueOf(engine.deleteDehydratedDevice(accountId), STEP_TIMEOUT_MS),
    );
    // The biggest, most hang-prone writes of the reset; this larger budget is the only
    // backstop for the whole multi-request sequence.
    const { recoveryKey } = await valueOf(
      engine.createRecoveryAndBackup(accountId),
      DESTRUCTIVE_TAIL_TIMEOUT_MS,
      () => new PartialRecoveryResetError(),
    );
    // The old key description, which nothing points at once the new default key is in
    // place. Best effort and bounded: it is inert, and a hang here would leave the user's
    // only copy of the new key undisplayed.
    if (previousKeyId) {
      await bestEffort(() =>
        valueOf(
          engine.dropKeyDescription(accountId, previousKeyId),
          STEP_TIMEOUT_MS,
        ),
      );
    }
    return recoveryKey;
  } catch (cause) {
    // The identity is already published. Every failure from here is necessarily partial,
    // whether it is a timeout, key generation failure, or an ordinary engine failure.
    throw cause instanceof PartialRecoveryResetError
      ? cause
      : new PartialRecoveryResetError();
  } finally {
    await ctx.refreshStatus();
  }
}

/**
 * Complete a password UIA round-trip against a harmless request and return the accepted
 * password (null if the server asked for none).
 *
 * A refusal — cancelled prompt, no password stage, out of attempts — stops the reset while
 * it is still free. Any other failure is the probe itself failing (a dropped connection, or
 * a server that gates `/delete_devices` differently from the key upload) and must not
 * become a new way for the reset to fail: the upload's own prompt still asks.
 */
async function preAuthenticate(
  { engine, accountId }: RecoveryResetContext,
  promptPassword: PasswordPrompt,
): Promise<string | null> {
  const result = await lastValueFrom(
    answerPasswordPrompts(
      engine,
      accountId,
      engine.preAuthenticate(accountId),
      promptPassword,
    ),
  );
  if (result.ok) return result.value.password;
  if (UIA_REFUSALS.includes(result.failure.code)) {
    throw new EngineRequestError(result.failure);
  }
  return null;
}

/**
 * Undo the one reversible thing a failed reset did, and re-seat the account's real
 * cross-signing identity locally — the engine may have rotated its private keys before
 * the upload was authorised, so without a forced re-query of the published identity this
 * device would go on believing in an identity the server has never seen.
 *
 * Best effort by construction: it must never replace the error that caused it. The two
 * repairs are independent, and get an attempt and a budget each — the pointer restore is
 * the one that can hang on a stalled sync, and it must not starve the cheap local one.
 *
 * Also used when the park itself does not confirm, where nothing has been rotated yet and
 * the re-query is a harmless no-op; both repairs are idempotent.
 */
async function abandonReset(
  ctx: RecoveryResetContext,
  previousKeyId: string | null,
): Promise<void> {
  // `ctx` holds the caller's captures, not whatever account is active now — an account
  // switch mid-reset must not point the repair at the wrong one.
  await bestEffort(() => restoreDefaultKeyId(ctx, previousKeyId));
  await bestEffort(() =>
    valueOf(ctx.engine.ownIdentityCheck(ctx.accountId), REPAIR_TIMEOUT_MS),
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
 * **Guaranteed: the server.** The `raw-retry` write is a bare PUT, retried through dropped
 * connections, that resolves on the HTTP response, so it is *the* writer here:
 * unconditional, first, and its failure fails this repair. On exactly the failure this
 * repair exists for (the park's PUT landed, its /sync echo did not) the LOCAL store still
 * holds the PRE-park value, so reading it back would "confirm" a wrong server state and
 * skip the only write that fixes it. No read gates this write.
 *
 * **Best effort: this client's own view**, via a `confirmed` write of the same pointer
 * (which skips when the local store already agrees, since js `setDefaultKeyId` never
 * resolves on an equal value), because `status` is computed from that local store and a
 * stale `needs-setup` puts a "set up recovery" button — which mints a new 4S key and deletes the key backup — in front of the
 * user. Bounded, and never allowed to fail the repair. When it cannot run, the server is
 * still right for every other device, and `TrustService.setUp` refuses on a server read of
 * its own rather than trusting the local one.
 */
async function restoreDefaultKeyId(
  { engine, accountId }: RecoveryResetContext,
  previousKeyId: string | null,
): Promise<void> {
  if (!previousKeyId) {
    return;
  }
  await valueOf(
    engine.setDefaultKeyPointer(accountId, previousKeyId, 'raw-retry'),
    REPAIR_TIMEOUT_MS,
  );
  await bestEffort(() =>
    valueOf(
      engine.setDefaultKeyPointer(accountId, previousKeyId, 'confirmed'),
      REPAIR_TIMEOUT_MS,
    ),
  );
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
 * The step's value, or its failure thrown. With `ms`, not forever: a step that does not
 * answer within it fails with `onTimeout`'s error, whatever it goes on to do.
 */
async function valueOf<T>(
  step: Observable<EngineResult<T>>,
  ms?: number,
  onTimeout: () => Error = () =>
    new Error('Timed out waiting for the homeserver.'),
): Promise<T> {
  const result = await firstValueFrom(
    ms === undefined
      ? step
      : step.pipe(timeout({ first: ms, with: () => throwError(onTimeout) })),
  );
  if (!result.ok) throw new EngineRequestError(result.failure);
  return result.value;
}
