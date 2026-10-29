import {
  BehaviorSubject,
  type Observable,
  concatMap,
  type Subscription,
  filter,
  firstValueFrom,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EngineResult,
  assertPlainData,
  decryptMegolmKeyFile,
} from '@trinity/util/matrix';
import type {
  InteractiveUpdate,
  TrustEngine,
  TrustFacts,
  VerificationSnapshot,
} from '../lib/trust-engine';

export interface TrustContractSetup {
  readonly engine: TrustEngine;
  /** A live, synced account in `engine` with crypto and no identity yet. */
  readonly alice: string;
  /** Alice's password, which the server's password prompts accept. */
  readonly password: string;
  /** The device `engine` runs as for alice. */
  readonly deviceId: string;
  /** Another user of the server, whose identity alice has not seen yet. */
  readonly bob: string;
  /** Alice signs in on another device; resolves its id. */
  addDevice(): Promise<string>;
  /** Another device of alice's publishes a cross-signing identity. */
  publishIdentityElsewhere(): Promise<void>;
  /** Bob publishes a new identity and alice's engine fetches it. */
  bobPublishesIdentity(): Promise<void>;
  /** Alice's device here creates and publishes a cross-signing identity. */
  publishIdentity(): Promise<void>;
  /** Another client of alice's points the server's secret storage at `keyId`. */
  setServerDefaultKey(keyId: string): Promise<void>;
  /** Signs alice in on another device, which then asks to verify the one in `engine`. */
  secondDevice(): Promise<{
    readonly deviceId: string;
    requestVerification(): Promise<void>;
  }>;
  /** Another user with a published identity, in an encrypted DM with alice. */
  directRoom(): Promise<{ readonly userId: string; readonly roomId: string }>;
  /**
   * Another device of alice's publishes an identity, secret storage and a key backup,
   * from a random recovery key or from `passphrase`; resolves the recovery key.
   */
  setUpRecoveryElsewhere(passphrase?: string): Promise<string>;
  /**
   * Alice's device here rotates its identity for a reset whose upload is then cancelled,
   * then re-reads the published identity, as an abandoned reset does.
   */
  strandUnpublishedIdentity(): Promise<void>;
  /** Another session of alice's exports a room key it holds, with `passphrase`. */
  exportFromAnotherSession(
    passphrase: string,
  ): Promise<{ readonly fileText: string; readonly sessionId: string }>;
  /** A fresh session of alice's imports the key file; resolves the session ids it then holds. */
  importInAnotherSession(
    fileText: string,
    passphrase: string,
  ): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

export interface TrustContractTiming {
  /** How long a change may take to reach a subscription. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

const NOBODY = '@nobody:invalid';

/** A well-formed recovery key that unlocks nothing. */
const WRONG_KEY = 'EsT3 4kza y1Xs efFA tKyi HVwT kdEP 4UEk rvNr dFvy 8nGq AkqP';

const NOTHING_READY: TrustFacts = {
  crossSigningReady: false,
  secretStorageReady: false,
  keyBackupActive: false,
  hasDefaultKey: false,
  thisDeviceCrossSigned: false,
  crossSigning: {
    publicKeysOnDevice: false,
    privateKeysInSecretStorage: false,
    privateKeysCachedLocally: {
      masterKey: false,
      selfSigningKey: false,
      userSigningKey: false,
    },
  },
};

export function defineTrustEngineContract(
  setup: () => Promise<TrustContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: TrustContractTiming,
): void {
  describe('TrustEngine contract', () => {
    let context: TrustContractSetup;
    /** False when setup threw: there is nothing to dispose. */
    let setUp = false;
    let engine: TrustEngine;
    let alice: string;
    let subscriptions: Subscription[];

    beforeEach(async () => {
      setUp = false;
      context = await setup();
      setUp = true;
      ({ engine, alice } = context);
      subscriptions = [];
    }, testTimeoutMs);

    afterEach(async () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      if (setUp) await context.dispose();
    }, testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    async function value<T>(source: Observable<EngineResult<T>>): Promise<T> {
      const result = await once(source);
      if (!result.ok) throw new Error(`Command failed: ${result.failure.code}`);
      return result.value;
    }

    /** The own identity check, which must know an identity. */
    async function knownIdentity() {
      const check = await value(engine.ownIdentityCheck(alice));
      if (!check.identityKnown) throw new Error('No identity known');
      return check;
    }

    async function code(source: Observable<EngineResult<unknown>>) {
      const result = await once(source);
      return result.ok ? 'ok' : result.failure.code;
    }

    /** `ok`, or why a recovery or key import was refused. */
    async function refusal(source: Observable<EngineResult<unknown>>) {
      const result = await once(source);
      if (result.ok) return 'ok';
      if (result.failure.code !== 'recovery-refused') {
        throw new Error(`Not refused: ${result.failure.code}`);
      }
      return result.failure.params.reason;
    }

    /** Subscribes; every emission must be plain data. Resolves the first matching one. */
    function watch<T>(source: Observable<T>) {
      const emissions = new BehaviorSubject<T[]>([]);
      subscriptions.push(
        source.subscribe((item) => {
          expect(() => assertPlainData(item)).not.toThrow();
          emissions.next([...emissions.value, item]);
        }),
      );
      return {
        emissions: () => emissions.value,
        until: (predicate: (item: T) => boolean) =>
          firstValueFrom(
            emissions.pipe(
              filter((all) => all.length > 0 && predicate(all.at(-1) as T)),
              timeout(settleTimeoutMs),
            ),
          ).then((all) => all.at(-1) as T),
      };
    }

    const factsOf = (result: EngineResult<TrustFacts>) =>
      result.ok ? result.value : null;

    /**
     * Runs an interactive command, answering each prompt from `answers` (null once they
     * run out). Every update must be plain data, `done` must come last, exactly once.
     */
    async function interactive<T>(
      source: Observable<InteractiveUpdate<T>>,
      answers: (string | null)[],
    ) {
      const updates: InteractiveUpdate<T>[] = [];
      await new Promise<void>((resolve, reject) => {
        const subscription = source.subscribe({
          next: (update) => {
            expect(() => assertPlainData(update)).not.toThrow();
            updates.push(update);
            if (update.kind !== 'password-required') return;
            engine
              .answerPrompt(alice, update.promptId, answers.shift() ?? null)
              .subscribe((answered) => {
                if (!answered.ok) reject(new Error(answered.failure.code));
              });
          },
          error: reject,
          complete: resolve,
        });
        subscriptions.push(subscription);
      });
      const done = updates.at(-1);
      if (done?.kind !== 'done') throw new Error('No done update');
      expect(updates.filter((u) => u.kind === 'done')).toHaveLength(1);
      return {
        prompts: updates.flatMap((u) =>
          u.kind === 'password-required' ? [u.rejected] : [],
        ),
        result: done.result,
      };
    }

    const resultCode = (result: EngineResult<unknown>) =>
      result.ok ? 'ok' : result.failure.code;

    const deviceIds = (
      result: EngineResult<readonly { deviceId: string }[]>,
    ) => (result.ok ? result.value.map((d) => d.deviceId) : []);

    it(
      'emits the facts of a fresh account first, with nothing ready',
      async () => {
        const facts = watch(engine.facts(alice));

        const first = await facts.until(() => true);

        expect(first).toEqual({ ok: true, value: NOTHING_READY });
      },
      testTimeoutMs,
    );

    it(
      'fails reads for an account that is not live',
      async () => {
        const facts = watch(engine.facts(NOBODY));
        const first = await facts.until(() => true);

        expect(first.ok ? 'ok' : first.failure.code).toBe('account-not-live');
        expect(await code(engine.ownIdentityCheck(NOBODY))).toBe(
          'account-not-live',
        );
        expect(await code(engine.serverDefaultKeyId(NOBODY))).toBe(
          'account-not-live',
        );
        expect(await code(engine.publishedMasterKey(NOBODY))).toBe(
          'account-not-live',
        );
        const devices = await watch(engine.ownDevices(NOBODY)).until(
          () => true,
        );
        expect(resultCode(devices)).toBe('account-not-live');
        const trust = await watch(engine.userTrust(NOBODY, alice)).until(
          () => true,
        );
        expect(resultCode(trust)).toBe('account-not-live');
        expect(await code(engine.renameDevice(NOBODY, 'X', 'name'))).toBe(
          'account-not-live',
        );
        const deleted = await interactive(engine.deleteDevice(NOBODY, 'X'), []);
        expect(resultCode(deleted.result)).toBe('account-not-live');
        expect(
          await code(
            engine.recover(NOBODY, { kind: 'recovery-key', value: WRONG_KEY }),
          ),
        ).toBe('account-not-live');
        expect(await code(engine.exportRoomKeys(NOBODY, 'pass'))).toBe(
          'account-not-live',
        );
        expect(await code(engine.importRoomKeys(NOBODY, 'file', 'pass'))).toBe(
          'account-not-live',
        );
      },
      testTimeoutMs,
    );

    it(
      'reports no identity on an account that publishes none',
      async () => {
        // No identity after the re-query: nothing else is read.
        expect(await value(engine.ownIdentityCheck(alice))).toEqual({
          identityKnown: false,
        });
        expect(await value(engine.publishedMasterKey(alice))).toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'reports a published identity held here, and the facts follow it',
      async () => {
        const facts = watch(engine.facts(alice));
        await facts.until(() => true);

        await context.publishIdentity();

        const held = factsOf(
          await facts.until((r) => !!factsOf(r)?.thisDeviceCrossSigned),
        );
        expect(held).toMatchObject({
          crossSigningReady: true,
          thisDeviceCrossSigned: true,
          crossSigning: {
            publicKeysOnDevice: true,
            privateKeysCachedLocally: {
              masterKey: true,
              selfSigningKey: true,
              userSigningKey: true,
            },
          },
        });
        const check = await knownIdentity();
        expect(check.publishedMasterKey).toEqual(expect.any(String));
        expect(check.localMasterKey).toBe(check.publishedMasterKey);
        expect(await value(engine.publishedMasterKey(alice))).toBe(
          check.publishedMasterKey,
        );
        expect(check.facts).toMatchObject({
          crossSigningReady: true,
          thisDeviceCrossSigned: true,
        });
      },
      testTimeoutMs,
    );

    it(
      "reads the server's secret-storage pointer, null until it is set",
      async () => {
        const facts = watch(engine.facts(alice));
        expect(await value(engine.serverDefaultKeyId(alice))).toBeNull();

        await context.setServerDefaultKey('contract-key');

        expect(await value(engine.serverDefaultKeyId(alice))).toBe(
          'contract-key',
        );
        // The local pointer follows once the change arrives.
        await facts.until((r) => !!factsOf(r)?.hasDefaultKey);
      },
      testTimeoutMs,
    );

    it(
      'has no verification on a fresh account or one that is not live',
      async () => {
        expect(await firstValueFrom(engine.verification(alice))).toBeNull();
        expect(await firstValueFrom(engine.verification(NOBODY))).toBeNull();
        expect(await code(engine.requestOwnVerification(NOBODY))).toBe(
          'account-not-live',
        );
        expect(await code(engine.cancelVerification(NOBODY, 'flow'))).toBe(
          'account-not-live',
        );
        expect(await code(engine.acceptVerification(alice, 'flow'))).toBe(
          'verification-gone',
        );
        expect(await code(engine.showQr(alice, 'flow'))).toBe(
          'verification-gone',
        );
      },
      testTimeoutMs,
    );

    it(
      'requests its own verification and cancels it',
      async () => {
        await context.publishIdentity();
        const verification = watch(engine.verification(alice));

        const { flowId } = await value(engine.requestOwnVerification(alice));

        expect(
          await verification.until((s) => s?.flowId === flowId),
        ).toMatchObject({
          flowId,
          phase: 'requested',
          otherUserId: alice,
          isSelfVerification: true,
          initiatedByMe: true,
          sas: null,
          qrScannedByOther: false,
          cancellation: null,
        } satisfies Partial<VerificationSnapshot>);

        expect(await code(engine.cancelVerification(alice, flowId))).toBe('ok');

        expect(
          await verification.until((s) => s?.phase === 'cancelled'),
        ).toMatchObject({ flowId, cancellation: { code: 'm.user' } });
      },
      testTimeoutMs,
    );

    it(
      'reaches ready when another device of the account asks to verify this one',
      async () => {
        await context.publishIdentity();
        const second = await context.secondDevice();
        const verification = watch(engine.verification(alice));
        await verification.until(() => true);

        await second.requestVerification();

        const request = await verification.until(
          (s) => s?.otherDeviceId === second.deviceId,
        );
        expect(request).toMatchObject({
          phase: 'requested',
          otherUserId: alice,
          isSelfVerification: true,
          initiatedByMe: false,
        });
        const flowId = request?.flowId ?? '';

        expect(await code(engine.acceptVerification(alice, flowId))).toBe('ok');

        const ready = await verification.until((s) => s?.phase === 'ready');
        expect(ready?.flowId).toBe(flowId);
        expect(ready?.theirMethods).toContain('m.sas.v1');
        await once(engine.cancelVerification(alice, flowId));
      },
      testTimeoutMs,
    );

    it(
      'sends a DM verification request once the user identity is known, and forgets it unwatched',
      async () => {
        const { userId, roomId } = await context.directRoom();
        const verification = watch(engine.verification(alice));

        const { flowId } = await value(
          engine.requestUserVerification(alice, userId, roomId),
        );

        expect(
          await verification.until((s) => s?.flowId === flowId),
        ).toMatchObject({
          phase: 'requested',
          otherUserId: userId,
          isSelfVerification: false,
          initiatedByMe: true,
        });

        // Unwatched, the request is forgotten; a DM request is not taken up again.
        for (const subscription of subscriptions) subscription.unsubscribe();
        expect(await firstValueFrom(engine.verification(alice))).toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'lists the own devices, this one marked current',
      async () => {
        const other = await context.addDevice();

        const devices = await watch(engine.ownDevices(alice)).until((r) =>
          deviceIds(r).includes(other),
        );

        if (!devices.ok) throw new Error(devices.failure.code);
        expect(
          devices.value.find((d) => d.deviceId === context.deviceId),
        ).toMatchObject({ isCurrent: true });
        expect(devices.value.find((d) => d.deviceId === other)).toMatchObject({
          isCurrent: false,
          verified: false,
        });
      },
      testTimeoutMs,
    );

    it(
      'renames a device and the list follows',
      async () => {
        const other = await context.addDevice();
        const devices = watch(engine.ownDevices(alice));
        await devices.until((r) => deviceIds(r).includes(other));

        expect(await code(engine.renameDevice(alice, other, 'Contract'))).toBe(
          'ok',
        );

        await devices.until(
          (r) =>
            r.ok &&
            r.value.some(
              (d) => d.deviceId === other && d.displayName === 'Contract',
            ),
        );
      },
      testTimeoutMs,
    );

    it(
      'deletes a device after one password prompt and the list follows',
      async () => {
        const other = await context.addDevice();
        const devices = watch(engine.ownDevices(alice));
        await devices.until((r) => deviceIds(r).includes(other));

        const { prompts, result } = await interactive(
          engine.deleteDevice(alice, other),
          [context.password],
        );

        expect(prompts).toEqual([false]);
        expect(result).toEqual({ ok: true, value: null });
        await devices.until((r) => r.ok && !deviceIds(r).includes(other));
      },
      testTimeoutMs,
    );

    it(
      'asks again after a rejected password, then deletes',
      async () => {
        const other = await context.addDevice();

        const { prompts, result } = await interactive(
          engine.deleteDevice(alice, other),
          ['not-the-password', context.password],
        );

        expect(prompts).toEqual([false, true]);
        expect(result.ok).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'keeps the device when the prompt is cancelled',
      async () => {
        const other = await context.addDevice();

        const { result } = await interactive(
          engine.deleteDevice(alice, other),
          [null],
        );

        expect(resultCode(result)).toBe('uia-cancelled');
        const devices = await watch(engine.ownDevices(alice)).until(() => true);
        expect(deviceIds(devices)).toContain(other);
      },
      testTimeoutMs,
    );

    it(
      'cancels an open prompt when the command is unsubscribed',
      async () => {
        const other = await context.addDevice();
        const prompt = await firstValueFrom(
          engine
            .deleteDevice(alice, other)
            .pipe(filter((u) => u.kind === 'password-required')),
        );
        if (prompt.kind !== 'password-required') throw new Error('No prompt');

        expect(
          await code(
            engine.answerPrompt(alice, prompt.promptId, context.password),
          ),
        ).toBe('prompt-gone');
        const devices = await watch(engine.ownDevices(alice)).until(() => true);
        expect(deviceIds(devices)).toContain(other);
      },
      testTimeoutMs,
    );

    it(
      'gives up after three rejected passwords',
      async () => {
        const other = await context.addDevice();

        const { prompts, result } = await interactive(
          engine.deleteDevice(alice, other),
          ['wrong-1', 'wrong-2', 'wrong-3'],
        );

        expect(prompts).toEqual([false, true, true]);
        expect(resultCode(result)).toBe('uia-attempts-exceeded');
      },
      testTimeoutMs,
    );

    it(
      'refuses to delete the device it runs as, without a prompt',
      async () => {
        const { prompts, result } = await interactive(
          engine.deleteDevice(alice, context.deviceId),
          [context.password],
        );

        expect(prompts).toEqual([]);
        expect(resultCode(result)).toBe('unsupported');
      },
      testTimeoutMs,
    );

    it(
      'pre-authenticates and returns the accepted password',
      async () => {
        const { prompts, result } = await interactive(
          engine.preAuthenticate(alice),
          [context.password],
        );

        expect(prompts).toEqual([false]);
        expect(result).toEqual({
          ok: true,
          value: { password: context.password },
        });
      },
      testTimeoutMs,
    );

    it(
      "refuses another account's answer to an open prompt, which stays open",
      async () => {
        const other = await context.addDevice();
        let answered = false;
        const { prompts, result } = await interactive(
          engine.deleteDevice(alice, other).pipe(
            concatMap(async (update) => {
              if (update.kind === 'password-required' && !answered) {
                answered = true;
                expect(
                  await code(
                    engine.answerPrompt(
                      NOBODY,
                      update.promptId,
                      context.password,
                    ),
                  ),
                ).toBe('prompt-gone');
              }
              return update;
            }),
          ),
          [context.password],
        );

        expect(prompts).toEqual([false]);
        expect(result.ok).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'refuses an answer to a prompt that is not open',
      async () => {
        expect(
          await code(engine.answerPrompt(alice, 'no-such-prompt', 'x')),
        ).toBe('prompt-gone');
      },
      testTimeoutMs,
    );

    it(
      'sees an identity published by another device, not held here',
      async () => {
        await context.publishIdentityElsewhere();

        const check = await knownIdentity();

        expect(check.publishedMasterKey).toEqual(expect.any(String));
        expect(check.localMasterKey).not.toBe(check.publishedMasterKey);
        expect(check.facts.crossSigning.privateKeysCachedLocally).toEqual({
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        });
      },
      testTimeoutMs,
    );

    it(
      "follows another user's identity: pinned on sight, a change needs approval until pinned",
      async () => {
        const bob = watch(engine.userTrust(alice, context.bob));
        const unverified = {
          verified: false,
          wasVerified: false,
          needsApproval: false,
        };
        expect(await bob.until(() => true)).toEqual({
          ok: true,
          value: unverified,
        });

        await context.bobPublishesIdentity();
        await context.bobPublishesIdentity();
        await bob.until((r) => r.ok && r.value.needsApproval);

        expect(await value(engine.pinIdentity(alice, context.bob))).toBeNull();

        await bob.until((r) => r.ok && !r.value.needsApproval);
        // Bob was never verified (that needs interactive verification), so this only checks
        // that withdraw succeeds; the fake spec checks it clears `wasVerified`.
        expect(
          await value(engine.withdrawVerification(alice, context.bob)),
        ).toBeNull();
        expect(bob.emissions().at(-1)).toEqual({ ok: true, value: unverified });
      },
      testTimeoutMs,
    );

    const recoveryKey = (text: string) =>
      ({ kind: 'recovery-key', value: text }) as const;
    const passphrase = (text: string) =>
      ({ kind: 'passphrase', value: text }) as const;
    const recovered = (r: EngineResult<TrustFacts>) =>
      !!factsOf(r)?.thisDeviceCrossSigned && !!factsOf(r)?.keyBackupActive;

    it(
      'recovers with the recovery key: this device is verified and key backup is on',
      async () => {
        const key = await context.setUpRecoveryElsewhere();
        const facts = watch(engine.facts(alice));

        expect(await refusal(engine.recover(alice, recoveryKey(key)))).toBe(
          'ok',
        );

        expect(factsOf(await facts.until(recovered))).toMatchObject({
          crossSigningReady: true,
          secretStorageReady: true,
          hasDefaultKey: true,
        });
      },
      testTimeoutMs,
    );

    it(
      'refuses a wrong recovery key and changes nothing',
      async () => {
        const key = await context.setUpRecoveryElsewhere();

        expect(
          await refusal(engine.recover(alice, recoveryKey(WRONG_KEY))),
        ).toBe('incorrect');

        const after = factsOf(
          await watch(engine.facts(alice)).until(() => true),
        );
        expect(after).toMatchObject({
          crossSigningReady: false,
          keyBackupActive: false,
          thisDeviceCrossSigned: false,
        });
        // The refused key left nothing behind that stops the right one.
        expect(await refusal(engine.recover(alice, recoveryKey(key)))).toBe(
          'ok',
        );
      },
      testTimeoutMs,
    );

    it(
      'tells a malformed recovery key from a wrong one',
      async () => {
        await context.setUpRecoveryElsewhere();

        expect(
          await refusal(
            engine.recover(alice, recoveryKey('not a recovery key')),
          ),
        ).toBe('malformed-key');
      },
      testTimeoutMs,
    );

    it(
      'refuses recovery on an account without secret storage',
      async () => {
        expect(
          await refusal(engine.recover(alice, recoveryKey(WRONG_KEY))),
        ).toBe('not-configured');
        expect(
          await refusal(engine.recover(alice, passphrase('any passphrase'))),
        ).toBe('not-configured');
      },
      testTimeoutMs,
    );

    it(
      'recovers with the recovery passphrase, refusing a wrong one',
      async () => {
        await context.setUpRecoveryElsewhere('contract passphrase');
        const facts = watch(engine.facts(alice));

        expect(
          await refusal(engine.recover(alice, passphrase('wrong passphrase'))),
        ).toBe('incorrect');
        expect(
          await refusal(
            engine.recover(alice, passphrase('contract passphrase')),
          ),
        ).toBe('ok');

        await facts.until(recovered);
      },
      testTimeoutMs,
    );

    it(
      'refuses a passphrase when secret storage was set up from a key',
      async () => {
        await context.setUpRecoveryElsewhere();

        expect(
          await refusal(engine.recover(alice, passphrase('any passphrase'))),
        ).toBe('no-passphrase');
      },
      testTimeoutMs,
    );

    it(
      'recovers after a reset cancelled at the password prompt (outcome only; the stranded-key repair is in the adapter spec)',
      async () => {
        const key = await context.setUpRecoveryElsewhere();
        await context.strandUnpublishedIdentity();
        const facts = watch(engine.facts(alice));
        // The js-sdk engine drops the unpublished keys when it re-reads the identity; an
        // engine may also keep them (the stranded case its recovery must repair).
        await facts.until((r) => factsOf(r)?.crossSigningReady === false);

        expect(await refusal(engine.recover(alice, recoveryKey(key)))).toBe(
          'ok',
        );

        await facts.until(recovered);
        const check = await knownIdentity();
        expect(check.localMasterKey).toBe(check.publishedMasterKey);
      },
      testTimeoutMs,
    );

    it(
      'imports a key file from another session, and its own export carries the key on',
      async () => {
        const other = await context.exportFromAnotherSession('first pass');

        expect(
          await code(
            engine.importRoomKeys(alice, other.fileText, 'first pass'),
          ),
        ).toBe('ok');
        const fileText = await value(
          engine.exportRoomKeys(alice, 'second pass'),
        );

        expect(fileText).toMatch(
          /^-----BEGIN MEGOLM SESSION DATA-----\n[A-Za-z0-9+/=\n]+\n-----END MEGOLM SESSION DATA-----$/,
        );
        expect(
          await context.importInAnotherSession(fileText, 'second pass'),
        ).toContain(other.sessionId);
      },
      testTimeoutMs,
    );

    it(
      'refuses a wrong passphrase or a file that is not a key file, importing nothing',
      async () => {
        const other = await context.exportFromAnotherSession('right pass');

        expect(
          await refusal(
            engine.importRoomKeys(alice, other.fileText, 'wrong pass'),
          ),
        ).toBe('incorrect');
        expect(
          await refusal(engine.importRoomKeys(alice, 'not a key file', 'pass')),
        ).toBe('incorrect');

        const fileText = await value(engine.exportRoomKeys(alice, 'pass'));
        const held = JSON.parse(
          await decryptMegolmKeyFile(fileText, 'pass'),
        ) as { session_id: string }[];
        expect(held.map((key) => key.session_id)).not.toContain(
          other.sessionId,
        );
      },
      testTimeoutMs,
    );
  });
}
