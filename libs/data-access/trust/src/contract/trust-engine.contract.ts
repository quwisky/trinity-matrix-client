import {
  BehaviorSubject,
  type Observable,
  type Subscription,
  filter,
  firstValueFrom,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EngineResult, assertPlainData } from '@trinity/util/matrix';
import type { TrustEngine, TrustFacts } from '../lib/trust-engine';

export interface TrustContractSetup {
  readonly engine: TrustEngine;
  /** A live, synced account in `engine` with crypto and no identity yet. */
  readonly alice: string;
  /** Alice's device here creates and publishes a cross-signing identity. */
  publishIdentity(): Promise<void>;
  /** Another client of alice's points the server's secret storage at `keyId`. */
  setServerDefaultKey(keyId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface TrustContractTiming {
  /** How long a change may take to reach a subscription. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

const NOBODY = '@nobody:invalid';

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

    async function code(source: Observable<EngineResult<unknown>>) {
      const result = await once(source);
      return result.ok ? 'ok' : result.failure.code;
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
      },
      testTimeoutMs,
    );

    it(
      'reports no identity on an account that publishes none',
      async () => {
        expect(await value(engine.ownIdentityCheck(alice))).toEqual({
          identityKnown: false,
          publishedMasterKey: null,
          localMasterKey: null,
          facts: NOTHING_READY,
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
        const check = await value(engine.ownIdentityCheck(alice));
        expect(check.identityKnown).toBe(true);
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
  });
}
