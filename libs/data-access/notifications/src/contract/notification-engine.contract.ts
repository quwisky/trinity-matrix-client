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
  PushRuleKind,
  RoomNotifyMode,
} from '../lib/notification-engine';

/** A rule of the account's as the server holds it. */
export interface ServerRoomRule {
  readonly kind: PushRuleKind;
  readonly ruleId: string;
  readonly enabled: boolean;
  readonly actions: unknown;
}

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
  /** Another client of alice's PUTs a room or override rule, then switches it off unless `enabled`. */
  foreignRoomRule(
    kind: 'room' | 'override',
    ruleId: string,
    rule: { readonly actions: unknown[]; readonly conditions?: unknown[] },
    enabled: boolean,
  ): Promise<void>;
  /** Alice's room, override and underride rules keyed by or matching `roomId`, sorted by kind and id. */
  roomRules(roomId: string): Promise<readonly ServerRoomRule[]>;
  /** Another client of alice's writes account data. */
  foreignAccountData(type: string, content: object): Promise<void>;
  /** Alice's account data of `type` as the server holds it, or undefined. */
  accountData(type: string): Promise<unknown>;
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
const SOUND = 'dev.trinityproject.trinity.notification_sound';
const LEGACY_SOUND = 'eu.qwky.trinity.notification_sound';
const REACTIONS = 'dev.trinityproject.trinity.reaction_notifications';
const LEGACY_REACTIONS = 'eu.qwky.trinity.reaction_notifications';

/** The rule each mode writes, as Rust `set_room_notification_mode` writes it. */
function modeRules(roomId: string, mode: RoomNotifyMode): ServerRoomRule[] {
  switch (mode) {
    case 'all':
      return [
        {
          kind: 'room',
          ruleId: roomId,
          enabled: true,
          actions: ['notify', { set_tweak: 'sound', value: 'default' }],
        },
      ];
    case 'mentions':
      return [{ kind: 'room', ruleId: roomId, enabled: true, actions: [] }];
    case 'mute':
      return [{ kind: 'override', ruleId: roomId, enabled: true, actions: [] }];
  }
}

function roomMatch(roomId: string): unknown[] {
  return [{ kind: 'event_match', key: 'room_id', pattern: roomId }];
}

/** Today's keyword actions; highlight is what colours the room in the list. */
const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

function unique(): string {
  return `w${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueRoom(): string {
  return `!${unique()}:contract.invalid`;
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

    async function value<T>(source: Observable<EngineResult<T>>): Promise<T> {
      const result = await once(source);
      if (!result.ok) throw new Error(`Command failed: ${result.failure.code}`);
      return result.value;
    }

    /** Polls `read` until it returns `expected`, for a write the engine makes on its own. */
    async function eventually(
      read: () => Promise<unknown>,
      expected: unknown,
    ): Promise<void> {
      const deadline = Date.now() + settleTimeoutMs;
      let last = await read();
      while (JSON.stringify(last) !== JSON.stringify(expected)) {
        if (Date.now() > deadline) expect(last).toEqual(expected);
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await read();
      }
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
      'round-trips all, mentions and mute, replying once the snapshot holds the mode',
      async () => {
        const settings = watch(engine.settings(alice));
        const room = uniqueRoom();
        expect(settings.latest().roomModes).toEqual({});
        expect(await value(engine.readRoomMode(alice, room))).toBe('all');

        // Like Rust, `all` on a room without rules still writes its notifying room rule.
        for (const mode of [
          'all',
          'mentions',
          'mute',
          'mentions',
          'all',
        ] as const) {
          await ok(engine.setRoomMode(alice, room, mode));

          expect(settings.latest().roomModes[room] ?? 'all').toBe(mode);
          expect(await value(engine.readRoomMode(alice, room))).toBe(mode);
          expect(await context.roomRules(room)).toEqual(modeRules(room, mode));
        }
        expect(settings.latest().roomModes).toEqual({});
      },
      testTimeoutMs,
    );

    it(
      'replaces the room’s custom rules with the rule for the mode, as Rust does',
      async () => {
        const settings = watch(engine.settings(alice));
        const room = uniqueRoom();
        const other = uniqueRoom();
        const customId = `custom-${unique()}`;
        await context.foreignRoomRule(
          'override',
          customId,
          { actions: ['notify'], conditions: roomMatch(room) },
          true,
        );
        await context.foreignRoomRule(
          'room',
          room,
          { actions: ['notify', { set_tweak: 'sound', value: 'ping' }] },
          true,
        );
        await context.foreignRoomRule('room', other, { actions: [] }, true);
        // Another client's rules that still notify read as `all`.
        expect(await value(engine.readRoomMode(alice, room))).toBe('all');
        expect(settings.latest().roomModes).toEqual({ [other]: 'mentions' });

        await ok(engine.setRoomMode(alice, room, 'mute'));

        expect(await context.roomRules(room)).toEqual(modeRules(room, 'mute'));
        expect(settings.latest().roomModes).toEqual({
          [room]: 'mute',
          [other]: 'mentions',
        });

        await ok(engine.setRoomMode(alice, room, 'all'));

        expect(await context.roomRules(room)).toEqual(modeRules(room, 'all'));
        expect(settings.latest().roomModes).toEqual({ [other]: 'mentions' });
        expect(await context.roomRules(other)).toEqual(
          modeRules(other, 'mentions'),
        );
      },
      testTimeoutMs,
    );

    it(
      'runs back-to-back room-mode writes one after another, so the last one wins alone',
      async () => {
        const settings = watch(engine.settings(alice));
        const room = uniqueRoom();

        const [muted, all] = await Promise.all([
          once(engine.setRoomMode(alice, room, 'mute')),
          once(engine.setRoomMode(alice, room, 'all')),
        ]);

        expect([muted.ok, all.ok]).toEqual([true, true]);
        expect(await context.roomRules(room)).toEqual(modeRules(room, 'all'));
        expect(settings.latest().roomModes).toEqual({});
      },
      testTimeoutMs,
    );

    it(
      'enables a disabled rule of the chosen mode, and reads a disabled one as nothing',
      async () => {
        const settings = watch(engine.settings(alice));
        const room = uniqueRoom();
        await context.foreignRoomRule(
          'override',
          room,
          { actions: [], conditions: roomMatch(room) },
          false,
        );
        await context.foreignRoomRule('room', room, { actions: [] }, false);
        expect(await value(engine.readRoomMode(alice, room))).toBe('all');

        await ok(engine.setRoomMode(alice, room, 'mute'));

        expect(settings.latest().roomModes).toEqual({ [room]: 'mute' });
        expect(await context.roomRules(room)).toEqual(modeRules(room, 'mute'));
      },
      testTimeoutMs,
    );

    it(
      'round-trips the preferences, defaulting to sound on and reactions off',
      async () => {
        const settings = watch(engine.settings(alice));
        expect(settings.latest()).toMatchObject({
          sound: true,
          reactionNotifications: false,
        });

        await ok(engine.setPreference(alice, 'sound', false));
        await ok(engine.setPreference(alice, 'reactionNotifications', true));

        expect(settings.latest()).toMatchObject({
          sound: false,
          reactionNotifications: true,
        });
        expect(await context.accountData(SOUND)).toEqual({ enabled: false });
        expect(await context.accountData(REACTIONS)).toEqual({ enabled: true });

        await ok(engine.setPreference(alice, 'sound', true));

        expect(settings.latest().sound).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'reads the retired preference names while only they exist, and copies them across',
      async () => {
        const settings = watch(engine.settings(alice));
        await context.foreignAccountData(LEGACY_SOUND, { enabled: false });
        await context.foreignAccountData(LEGACY_REACTIONS, { enabled: true });

        await settings.until(
          (latest) => !latest.sound && latest.reactionNotifications,
        );
        await eventually(() => context.accountData(SOUND), { enabled: false });
        await eventually(() => context.accountData(REACTIONS), {
          enabled: true,
        });

        // The current name wins once it exists.
        await ok(engine.setPreference(alice, 'sound', true));
        expect(settings.latest().sound).toBe(true);
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
        expect(
          await failure(engine.setRoomMode(NOBODY, uniqueRoom(), 'mute')),
        ).toBe('account-not-live');
        const read = await once(engine.readRoomMode(NOBODY, uniqueRoom()));
        expect(read.ok ? 'ok' : read.failure.code).toBe('account-not-live');
        expect(
          await failure(engine.setPreference(NOBODY, 'sound', false)),
        ).toBe('account-not-live');
        expect(watch(engine.settings(NOBODY)).latest()).toEqual({
          loaded: false,
          defaultRules: [],
          keywords: [],
          roomModes: {},
          sound: true,
          reactionNotifications: false,
        });
      },
      testTimeoutMs,
    );
  });
}
