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
import type {
  NotificationEngine,
  NotificationSettings,
} from '../lib/notification-engine';

export interface NotificationContractSetup {
  readonly engine: NotificationEngine;
  /** A live, synced account in `engine`. */
  readonly alice: string;
  /** Another client of alice's writes the content rule `ruleId` matching `pattern`. */
  foreignKeywordRule(
    ruleId: string,
    pattern: string,
    enabled: boolean,
  ): Promise<void>;
  /** The actions of alice's content rule `ruleId` as the server holds them. */
  keywordActions(ruleId: string): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface NotificationContractTiming {
  /** How long another client's change may take to reach a subscription. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface Watch {
  readonly emissions: NotificationSettings[];
  latest(): NotificationSettings;
  until(
    predicate: (value: NotificationSettings) => boolean,
  ): Promise<NotificationSettings>;
}

const NOBODY = '@nobody:invalid';

/** Today's keyword actions; highlight is what colours the room in the list. */
const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

function unique(): string {
  return `w${Math.random().toString(36).slice(2, 10)}`;
}

function enabledOf(
  settings: NotificationSettings,
  ruleId: string,
): boolean | undefined {
  return settings.defaultRules.find((rule) => rule.ruleId === ruleId)?.enabled;
}

export function defineNotificationEngineContract(
  setup: () => Promise<NotificationContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: NotificationContractTiming,
): void {
  describe('NotificationEngine contract', () => {
    let context: NotificationContractSetup;
    let engine: NotificationEngine;
    let alice: string;
    let subscriptions: Subscription[];

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice } = context);
      subscriptions = [];
    }, testTimeoutMs);

    afterEach(async () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      await context.dispose();
    }, testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    async function ok(source: Observable<EngineResult<null>>): Promise<void> {
      const result = await once(source);
      if (!result.ok) throw new Error(`Command failed: ${result.failure.code}`);
      expect(result.value).toBeNull();
    }

    /** Subscribes; every emission must be plain data, and the first must arrive synchronously. */
    function watch(source: Observable<NotificationSettings>): Watch {
      const emissions: NotificationSettings[] = [];
      const latest = new BehaviorSubject<NotificationSettings[]>(emissions);
      subscriptions.push(
        source.subscribe((value) => {
          expect(() => assertPlainData(value)).not.toThrow();
          emissions.push(value);
          latest.next(emissions);
        }),
      );
      expect(emissions).toHaveLength(1);
      return {
        emissions,
        latest: () => emissions.at(-1) as NotificationSettings,
        until: (predicate) =>
          firstValueFrom(
            latest.pipe(
              filter((all) => predicate(all.at(-1) as NotificationSettings)),
              timeout(settleTimeoutMs),
            ),
          ).then((all) => all.at(-1) as NotificationSettings),
      };
    }

    it(
      'emits a loaded snapshot on subscribe with the server rules and no keywords',
      () => {
        const settings = watch(engine.settings(alice)).latest();

        expect(settings.loaded).toBe(true);
        expect(settings.keywords).toEqual([]);
        expect(settings.defaultRules).toContainEqual({
          ruleId: '.m.rule.master',
          kind: 'override',
          enabled: false,
        });
        expect(
          settings.defaultRules.every((rule) => rule.ruleId.startsWith('.')),
        ).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'disables and enables push rules, replying once the snapshot holds the change',
      async () => {
        const settings = watch(engine.settings(alice));
        const rules = [
          { ruleId: '.m.rule.invite_for_me', kind: 'override' as const },
          { ruleId: '.m.rule.message', kind: 'underride' as const },
        ];
        expect(enabledOf(settings.latest(), '.m.rule.message')).toBe(true);

        await ok(engine.setPushRulesEnabled(alice, rules, false));
        expect(enabledOf(settings.latest(), '.m.rule.invite_for_me')).toBe(
          false,
        );
        expect(enabledOf(settings.latest(), '.m.rule.message')).toBe(false);

        await ok(engine.setPushRulesEnabled(alice, rules, true));
        expect(enabledOf(settings.latest(), '.m.rule.invite_for_me')).toBe(
          true,
        );
        expect(enabledOf(settings.latest(), '.m.rule.message')).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'adds a keyword, replying once the snapshot holds it',
      async () => {
        const settings = watch(engine.settings(alice));
        const word = unique();

        await ok(engine.setKeyword(alice, word));

        expect(settings.latest().keywords).toEqual([
          { pattern: word, enabled: true },
        ]);
        expect(await context.keywordActions(word)).toEqual(KEYWORD_ACTIONS);
      },
      testTimeoutMs,
    );

    it(
      'enables a keyword another client switched off, with the keyword actions',
      async () => {
        const settings = watch(engine.settings(alice));
        const word = unique();
        await context.foreignKeywordRule(word, word, false);
        await settings.until((latest) =>
          latest.keywords.some(
            (keyword) => keyword.pattern === word && !keyword.enabled,
          ),
        );
        expect(settings.latest().keywords).toEqual([
          { pattern: word, enabled: false },
        ]);

        await ok(engine.setKeyword(alice, word));

        expect(settings.latest().keywords).toEqual([
          { pattern: word, enabled: true },
        ]);
        expect(await context.keywordActions(word)).toEqual(KEYWORD_ACTIONS);
      },
      testTimeoutMs,
    );

    it(
      'setKeyword over a disabled rule whose id is the word but whose pattern differs leaves it enabled with the new pattern',
      async () => {
        const settings = watch(engine.settings(alice));
        const word = unique();
        const respelled = word.toUpperCase();
        // Legacy re-point data: the rule id is one spelling, its pattern another.
        await context.foreignKeywordRule(respelled, word, false);
        await settings.until((latest) =>
          latest.keywords.some(
            (keyword) => keyword.pattern === word && !keyword.enabled,
          ),
        );

        await ok(engine.setKeyword(alice, respelled));

        expect(settings.latest().keywords).toEqual([
          { pattern: respelled, enabled: true },
        ]);
        expect(await context.keywordActions(respelled)).toEqual(
          KEYWORD_ACTIONS,
        );
      },
      testTimeoutMs,
    );

    it(
      'removes every rule for a keyword, also one keyed by another id',
      async () => {
        const settings = watch(engine.settings(alice));
        const word = unique();
        await ok(engine.setKeyword(alice, word));
        await context.foreignKeywordRule(`${word}-other`, word, true);
        await context.foreignKeywordRule(unique(), 'kept', true);
        await settings.until((latest) =>
          latest.keywords.some((keyword) => keyword.pattern === 'kept'),
        );
        // A rule written without `before`/`after` goes first, so the order is the server's.
        expect(
          [...settings.latest().keywords].sort((a, b) =>
            a.pattern.localeCompare(b.pattern),
          ),
        ).toEqual([
          { pattern: 'kept', enabled: true },
          { pattern: word, enabled: true },
        ]);

        await ok(engine.removeKeyword(alice, word));

        expect(settings.latest().keywords).toEqual([
          { pattern: 'kept', enabled: true },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'fails commands for an account that is not live and emits an unloaded snapshot',
      async () => {
        const failure = async (
          source: Observable<EngineResult<null>>,
        ): Promise<string> => {
          const result = await once(source);
          return result.ok ? 'ok' : result.failure.code;
        };

        expect(
          await failure(
            engine.setPushRulesEnabled(
              NOBODY,
              [{ ruleId: '.m.rule.master', kind: 'override' }],
              true,
            ),
          ),
        ).toBe('account-not-live');
        expect(await failure(engine.setKeyword(NOBODY, 'word'))).toBe(
          'account-not-live',
        );
        expect(await failure(engine.removeKeyword(NOBODY, 'word'))).toBe(
          'account-not-live',
        );
        expect(watch(engine.settings(NOBODY)).latest()).toEqual({
          loaded: false,
          defaultRules: [],
          keywords: [],
        });
      },
      testTimeoutMs,
    );
  });
}
