// The reset's ORDER, on the fake engine: the guard every engine's reset is held to. What
// one engine's steps do underneath (echo waits, retries, request shapes) is in its adapter
// spec, e.g. js-sdk/js-sdk-trust-engine.reset.spec.ts.
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineFailure } from '@trinity/util/matrix';
import type { FakeStep, FakeTrustEngine } from '../contract/fake-trust-engine';
import { onFakeEngine } from './trust.spec-harness';

const failure = (code: string) =>
  ({
    kind: 'unexpected',
    code,
    diagnostic: { kind: 'unexpected' },
  }) as EngineFailure;

/** Alice with recovery set up on another device and lost: the account a reset is for. */
function lostRecovery() {
  const fixture = onFakeEngine();
  const { engine, alice } = fixture;
  engine.setUpRecoveryElsewhere(alice);
  const oldKeyId = engine.defaultKeyIds(alice).server ?? '';
  const oldMasterKey = currentMasterKey(engine, alice);
  return { ...fixture, oldKeyId, oldMasterKey };
}

function currentMasterKey(engine: FakeTrustEngine, accountId: string) {
  let key: string | null = null;
  engine.publishedMasterKey(accountId).subscribe((result) => {
    key = result.ok ? result.value : null;
  });
  return key;
}

/** The steps the reset ran, by name. */
const stepNames = (engine: FakeTrustEngine) =>
  engine.steps.map((step) => step.name);

/** Whether `step` ran at all. */
const ran = (engine: FakeTrustEngine, step: FakeStep) =>
  engine.steps.some((call) => call.name.startsWith(step));

/** The password changes elsewhere just before the upload, so the replay is rejected. */
function passwordChangesBeforeUpload(engine: FakeTrustEngine) {
  const rotate = engine.rotateCrossSigning.bind(engine);
  vi.spyOn(engine, 'rotateCrossSigning').mockImplementation(
    (accountId, replay) => {
      engine.password = 'changed-elsewhere';
      return rotate(accountId, replay);
    },
  );
}

/** Nothing destructive happened: no new identity, no new secret storage or backup. */
function expectNothingDestroyed(
  engine: FakeTrustEngine,
  alice: string,
  oldMasterKey: string | null,
) {
  expect(ran(engine, 'createRecoveryAndBackup')).toBe(false);
  expect(ran(engine, 'deleteDehydratedDevice')).toBe(false);
  expect(currentMasterKey(engine, alice)).toBe(oldMasterKey);
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.useRealTimers());

describe('resetRecovery', () => {
  it('publishes a new identity, then new secret storage and backup, and returns the NEW key', async () => {
    const { svc, engine, alice, oldKeyId, oldMasterKey } = lostRecovery();

    const shown = await firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );

    expect(shown).toMatch(/^Es/);
    expect(currentMasterKey(engine, alice)).not.toBe(oldMasterKey);
    expect(engine.defaultKeyIds(alice).server).not.toBe(oldKeyId);
    expect(svc.status()).toBe('ready');
    expect(svc.keyBackupActive()).toBe(true);
    expect(svc.thisDeviceVerified()).toBe(true);
  });

  // THE test. Call counts alone pass on a destructive ordering; only the sequence
  // distinguishes "authenticate, then destroy" from "destroy, then ask".
  it('authenticates, parks, rotates, and only then destroys', async () => {
    const { svc, engine, oldKeyId } = lostRecovery();

    await firstValueFrom(svc.resetRecovery(async () => engine.password));

    expect(stepNames(engine)).toEqual([
      'preAuthenticate',
      'setDefaultKeyPointer(null, confirmed)',
      'rotateCrossSigning',
      'deleteDehydratedDevice',
      'createRecoveryAndBackup',
      `dropKeyDescription(${oldKeyId})`,
    ]);
  });

  it('parks nothing and drops nothing when the account has no secret storage', async () => {
    const { svc, engine, alice } = onFakeEngine();
    engine.publishIdentityElsewhere(alice);

    await firstValueFrom(svc.resetRecovery(async () => engine.password));

    expect(stepNames(engine).some((name) => name.includes('raw-retry'))).toBe(
      false,
    );
    expect(ran(engine, 'dropKeyDescription')).toBe(false);
  });

  it('asks for the password once, replaying it into the key upload', async () => {
    const { svc, engine } = lostRecovery();
    const prompt = vi.fn(async () => engine.password);

    await firstValueFrom(svc.resetRecovery(prompt));

    expect(prompt).toHaveBeenCalledOnce();
  });

  it('falls back to asking when the replayed password is rejected', async () => {
    const { svc, engine } = lostRecovery();
    passwordChangesBeforeUpload(engine);
    const prompt = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(engine.password)
      .mockResolvedValue('changed-elsewhere');

    await firstValueFrom(svc.resetRecovery(prompt));

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('still gives the person three tries when the replayed password is rejected', async () => {
    // The replay is the reset's own retry, not one of the person's.
    const { svc, engine, alice, oldMasterKey } = lostRecovery();
    passwordChangesBeforeUpload(engine);
    const prompt = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(engine.password)
      .mockResolvedValue('wrong');

    await expect(
      firstValueFrom(svc.resetRecovery(prompt)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'permission-denied',
      recovery: 'retry',
    });

    // One for the pre-auth, then three of the person's own.
    expect(prompt).toHaveBeenCalledTimes(4);
    expectNothingDestroyed(engine, alice, oldMasterKey);
  });

  it('recomputes status, so the UI stops reporting the old posture', async () => {
    const { svc, engine } = lostRecovery();
    await firstValueFrom(svc.refresh());
    expect(svc.status()).toBe('needs-recovery');

    await firstValueFrom(svc.resetRecovery(async () => engine.password));

    expect(svc.status()).toBe('ready');
  });

  // Each of these is a route to the measured data loss: the account's backup used to be
  // gone by the time any of them could happen.
  for (const [label, code, kind, recovery] of [
    [
      'the person cancels the upload password prompt',
      'uia-cancelled',
      'cancelled',
      'none',
    ],
    [
      'the server will not take a password for the upload',
      'uia-unsupported',
      'provider-action-required',
      'open-provider',
    ],
    [
      'the upload password is wrong too many times',
      'uia-attempts-exceeded',
      'permission-denied',
      'retry',
    ],
    ['the upload itself fails', 'request-failed', 'server-failure', 'retry'],
  ] as const) {
    it(`destroys nothing and puts the pointer back when ${label}`, async () => {
      const { svc, engine, alice, oldKeyId, oldMasterKey } = lostRecovery();
      engine.scriptStep('rotateCrossSigning', failure(code));

      await expect(
        firstValueFrom(svc.resetRecovery(async () => engine.password)),
      ).rejects.toMatchObject({ operation: 'reset-recovery', kind, recovery });

      expectNothingDestroyed(engine, alice, oldMasterKey);
      // The effect, not the attempt: the pointer is back on the SERVER, by the unread
      // write, and then this device's own view.
      expect(engine.defaultKeyIds(alice)).toEqual({
        server: oldKeyId,
        local: oldKeyId,
      });
      expect(stepNames(engine).slice(2)).toEqual([
        'rotateCrossSigning',
        `setDefaultKeyPointer(${oldKeyId}, raw-retry)`,
        `setDefaultKeyPointer(${oldKeyId}, confirmed)`,
        'ownIdentityCheck',
      ]);
    });
  }

  it('re-seats the real identity after a refused upload', async () => {
    // The device rotated its keys before the upload was authorised; without a forced
    // re-query it believes in an identity nobody published.
    const { svc, engine } = lostRecovery();
    engine.scriptStep('rotateCrossSigning', failure('uia-cancelled'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({ kind: 'cancelled' });

    expect(stepNames(engine).at(-1)).toBe('ownIdentityCheck');
    // Then the status is recomputed: the pointer is back, so recovery is what is missing.
    expect(svc.status()).toBe('needs-recovery');
  });

  it('lets the original error through even if every repair of the rollback fails', async () => {
    const { svc, engine } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', { delayMs: 0 }); // the park, confirmed
    engine.scriptStep('rotateCrossSigning', failure('uia-cancelled'));
    engine.scriptStep('setDefaultKeyPointer', failure('request-failed'));
    engine.scriptStep('ownIdentityCheck', failure('request-failed'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({ operation: 'reset-recovery', kind: 'cancelled' });
  });

  it('still recomputes status when the destructive tail fails', async () => {
    // Past the point of no return the account HAS changed; the one thing left that can
    // still go wrong is the UI going on describing the account it used to be.
    const { svc, engine } = lostRecovery();
    engine.scriptStep('createRecoveryAndBackup', failure('request-failed'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'partial-update',
      recovery: 'review-security-settings',
      partial: true,
    });

    // The new identity is held; recomputed, not left at the pre-reset needs-recovery.
    expect(svc.thisDeviceVerified()).toBe(true);
    expect(svc.status()).toBe('needs-setup');
  });

  it('repairs the account it started on, not whichever is active now', async () => {
    // The password prompt is a long await. Switching accounts underneath it must not
    // point the rollback at the new account.
    const { svc, engine, alice, session } = lostRecovery();
    const bob = '@bob:contract.invalid';
    engine.addAccount(bob);
    engine.scriptStep('rotateCrossSigning', failure('uia-cancelled'));
    let asked = 0;

    await expect(
      firstValueFrom(
        svc.resetRecovery(async () => {
          if (++asked === 1) {
            session.update((snapshot) => ({
              ...snapshot,
              activeAccountId: bob,
            }));
          }
          return engine.password;
        }),
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });

    expect(engine.steps.every((step) => step.accountId === alice)).toBe(true);
  });

  it('delivers the original error even if the pointer restore never settles', async () => {
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', { delayMs: 0 }); // the park
    engine.scriptStep('rotateCrossSigning', failure('uia-cancelled'));
    engine.scriptStep('setDefaultKeyPointer', 'hang'); // the server write

    const failed = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    const assertion = expect(failed).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    // The cheap local repair still ran after the hanging one ran out of budget.
    expect(stepNames(engine).at(-1)).toBe('ownIdentityCheck');
  });

  it('re-seats the identity even while the local realign is hanging', async () => {
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', { delayMs: 0 }); // the park
    engine.scriptStep('rotateCrossSigning', failure('uia-cancelled'));
    engine.scriptStep('setDefaultKeyPointer', { delayMs: 0 }); // the server write
    engine.scriptStep('setDefaultKeyPointer', 'hang'); // the local realign

    const failed = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    const assertion = expect(failed).rejects.toMatchObject({
      kind: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(stepNames(engine).at(-1)).toBe('ownIdentityCheck');
  });

  it('refuses before anything is parked when the server offers no password stage', async () => {
    const { svc, engine, alice, oldKeyId, oldMasterKey } = lostRecovery();
    engine.requireProviderAuth(alice);

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'provider-action-required',
      recovery: 'open-provider',
    });

    expect(stepNames(engine)).toEqual(['preAuthenticate']);
    expect(engine.defaultKeyIds(alice).server).toBe(oldKeyId);
    expectNothingDestroyed(engine, alice, oldMasterKey);
  });

  // Cancelling used to cost the person their 4S pointer and a local key rotation, because
  // the only thing asked beforehand was whether the server OFFERS a password — never
  // whether this person knows it.
  it('performs no write and no rotation when the password prompt is cancelled', async () => {
    const { svc, engine, alice, oldKeyId } = lostRecovery();

    await expect(
      firstValueFrom(svc.resetRecovery(async () => null)),
    ).rejects.toMatchObject({ operation: 'reset-recovery', kind: 'cancelled' });

    expect(stepNames(engine)).toEqual(['preAuthenticate']);
    expect(engine.defaultKeyIds(alice).server).toBe(oldKeyId);
  });

  it('performs no write and no rotation when the password is wrong every time', async () => {
    const { svc, engine } = lostRecovery();
    const prompt = vi.fn(async () => 'wrong');

    await expect(
      firstValueFrom(svc.resetRecovery(prompt)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'permission-denied',
      recovery: 'retry',
    });

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(stepNames(engine)).toEqual(['preAuthenticate']);
  });

  it('goes ahead when the pre-authentication cannot answer, rather than inventing a failure', async () => {
    // A dropped connection, or a server that gates /delete_devices differently from the
    // key upload, leaves the person where they were and the upload still asks.
    const { svc, engine } = lostRecovery();
    engine.scriptStep('preAuthenticate', failure('request-failed'));
    const prompt = vi.fn(async () => engine.password);

    await expect(firstValueFrom(svc.resetRecovery(prompt))).resolves.toBeTypeOf(
      'string',
    );
    expect(prompt).toHaveBeenCalledOnce(); // by the upload
  });

  it('rolls back when an unchallenged pre-authentication leaves the upload asking first', async () => {
    // The residual of "authenticate first": a server that does not gate /delete_devices
    // (Synapse passes can_skip_ui_auth there; MSC3861 bypasses it) leaves the FIRST
    // prompt the person ever sees inside the upload, with the pointer already parked.
    const { svc, engine, alice, oldKeyId } = lostRecovery();
    engine.scriptStep('preAuthenticate', 'unchallenged');
    const order: string[] = [];

    await expect(
      firstValueFrom(
        svc.resetRecovery(async () => {
          order.push(...stepNames(engine), 'first prompt');
          return null; // the person cancels the one prompt they are given
        }),
      ),
    ).rejects.toMatchObject({ operation: 'reset-recovery', kind: 'cancelled' });

    expect(order).toEqual([
      'preAuthenticate',
      'setDefaultKeyPointer(null, confirmed)',
      'rotateCrossSigning',
      'first prompt',
    ]);
    expect(engine.defaultKeyIds(alice).server).toBe(oldKeyId);
    expect(stepNames(engine).at(-1)).toBe('ownIdentityCheck');
  });

  it('completes the reset when there is no dehydrated device to delete', async () => {
    const { svc, engine } = lostRecovery();
    engine.scriptStep('deleteDehydratedDevice', failure('request-failed'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).resolves.toBeTypeOf('string');
  });

  it('finishes the reset when the dehydrated-device delete never answers', async () => {
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('deleteDehydratedDevice', 'hang');

    const shown = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    const assertion = expect(shown).resolves.toMatch(/^Es/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('puts the pointer back on the server when the park goes out unconfirmed', async () => {
    // The park's PUT landed and its echo was lost: the LOCAL pointer still holds the
    // pre-park value while the SERVER holds none. Only an unread server write fixes it.
    const { svc, engine, alice, oldKeyId, oldMasterKey } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', 'unconfirmed');

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'server-failure',
      recovery: 'retry',
    });

    expect(engine.defaultKeyIds(alice)).toEqual({
      server: oldKeyId,
      local: oldKeyId,
    });
    // Aborted before a single key was rotated.
    expect(ran(engine, 'rotateCrossSigning')).toBe(false);
    expect(stepNames(engine)).toContain(
      `setDefaultKeyPointer(${oldKeyId}, raw-retry)`,
    );
    expectNothingDestroyed(engine, alice, oldMasterKey);
  });

  it('stops with nothing to put back when the park fails before writing', async () => {
    // A failed park wrote nothing, by the step's contract, so there is no restore step.
    const { svc, engine, alice, oldKeyId, oldMasterKey } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', failure('request-failed'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => engine.password)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'server-failure',
    });

    expect(stepNames(engine)).toEqual([
      'preAuthenticate',
      'setDefaultKeyPointer(null, confirmed)',
    ]);
    expect(engine.defaultKeyIds(alice)).toEqual({
      server: oldKeyId,
      local: oldKeyId,
    });
    expectNothingDestroyed(engine, alice, oldMasterKey);
  });

  it('stops waiting for a park that never answers after 30 s', async () => {
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('setDefaultKeyPointer', 'hang');
    let settled = false;

    const failed = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    ).finally(() => (settled = true));
    const assertion = expect(failed).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'server-failure',
    });
    await vi.advanceTimersByTimeAsync(29_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(ran(engine, 'rotateCrossSigning')).toBe(false);
  });

  it('writes nothing when the password prompt itself throws', async () => {
    const { svc, engine, alice, oldKeyId } = lostRecovery();

    await expect(
      firstValueFrom(
        svc.resetRecovery(async () => {
          throw new Error('dialog failed');
        }),
      ),
    ).rejects.toMatchObject({ operation: 'reset-recovery' });

    expect(stepNames(engine)).toEqual(['preAuthenticate']);
    expect(engine.defaultKeyIds(alice).server).toBe(oldKeyId);
  });

  it('shows the new recovery key even if dropping the old description never answers', async () => {
    // The last step runs AFTER the destructive tail. Hanging there would leave the
    // person's only copy of the new key undisplayed, with another reset as the only fix.
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('dropKeyDescription', 'hang');

    const shown = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    const assertion = expect(shown).resolves.toMatch(/^Es/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('gives up on a destructive tail that stops answering, and says it may be half-done', async () => {
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('createRecoveryAndBackup', 'hang');

    const failed = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    // Not "timed out": a timeout here cannot undo anything the tail already did, so the
    // person has to be told where to look rather than just that it failed.
    const assertion = expect(failed).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'partial-update',
      recovery: 'review-security-settings',
      partial: true,
    });
    await vi.advanceTimersByTimeAsync(151_000);
    await assertion;

    expect(svc.thisDeviceVerified()).toBe(true); // the finally still recomputed it
  });

  it('waits out a slow destructive tail rather than a stalled one', async () => {
    // The budget is above the ~110s a dead /sync long-poll takes to be noticed.
    vi.useFakeTimers();
    const { svc, engine } = lostRecovery();
    engine.scriptStep('createRecoveryAndBackup', { delayMs: 120_000 });

    const shown = firstValueFrom(
      svc.resetRecovery(async () => engine.password),
    );
    const assertion = expect(shown).resolves.toMatch(/^Es/);
    await vi.advanceTimersByTimeAsync(200_000);
    await assertion;
  });

  it('is not ready, without asking, on an account without crypto', async () => {
    const nocrypto = '@nocrypto:contract.invalid';
    const { svc, engine } = onFakeEngine(nocrypto);
    engine.addAccount(nocrypto, { crypto: false });
    const prompt = vi.fn(async () => engine.password);

    await expect(
      firstValueFrom(svc.resetRecovery(prompt)),
    ).rejects.toMatchObject({ operation: 'reset-recovery', kind: 'not-ready' });
    expect(prompt).not.toHaveBeenCalled();
  });
});
