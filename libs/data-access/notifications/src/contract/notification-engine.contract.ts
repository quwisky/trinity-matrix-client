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
import {
  type EngineResult,
  assertPlainData,
  recordFeed,
} from '@trinity/util/matrix';
import type {
  HttpPusher,
  IncomingNotification,
  NotificationEngine,
  NotificationSettings,
  PushRoom,
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
  /** Another user, whose display name is their localpart. */
  readonly bob: string;
  /** A room named `name` that alice has joined with bob, encrypted by its state when asked. */
  sharedRoom(name: string, encrypted: boolean): Promise<string>;
  /** `sender` (alice or bob) sends a text message, in the clear; resolves its event id. */
  send(sender: string, roomId: string, body: string): Promise<string>;
  /** Bob reacts to `targetEventId`; resolves the reaction's event id. */
  react(roomId: string, targetEventId: string, key: string): Promise<string>;
  /** Bob redacts one of his events. */
  redact(roomId: string, eventId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface NotificationContractTiming {
  /** How long another client's change may take to reach a subscription. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface Watch<T> {
  readonly emissions: T[];
  latest(): T;
  until(predicate: (value: T) => boolean): Promise<T>;
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

const APP_ID = 'dev.trinityproject.trinity.contract';

/** Synapse accepts only a gateway URL with this path. */
function pusher(): HttpPusher {
  return {
    appId: APP_ID,
    pushkey: unique(),
    appDisplayName: 'Trinity',
    lang: 'en',
    url: 'https://push.contract.invalid/_matrix/push/v1/notify',
    format: 'event_id_only',
    data: { trinity_render: 'device' },
  };
}

function uniqueRoom(): string {
  return `!${unique()}:contract.invalid`;
}

function localpartOf(userId: string): string {
  return userId.slice(1).split(':')[0];
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
    function watch<T>(source: Observable<T>): Watch<T> {
      const emissions: T[] = [];
      const latest = new BehaviorSubject<T[]>(emissions);
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
        latest: () => emissions.at(-1) as T,
        until: (predicate) =>
          firstValueFrom(
            latest.pipe(
              filter((all) => predicate(all.at(-1) as T)),
              timeout(settleTimeoutMs),
            ),
          ).then((all) => all.at(-1) as T),
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
      'fails commands for an account that is not live and emits empty snapshots',
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
        const target = await once(
          engine.reactionTarget(NOBODY, uniqueRoom(), '$target', ['$r']),
        );
        expect(target.ok ? 'ok' : target.failure.code).toBe('account-not-live');
        recordFeed(engine.notifications(NOBODY)).unsubscribe();
        expect(await failure(engine.setPusher(NOBODY, pusher()))).toBe(
          'account-not-live',
        );
        expect(
          await failure(engine.removePusher(NOBODY, APP_ID, unique())),
        ).toBe('account-not-live');
        const pushers = await once(engine.pushers(NOBODY));
        expect(pushers.ok ? 'ok' : pushers.failure.code).toBe(
          'account-not-live',
        );
        expect(watch(engine.pushRooms(NOBODY)).latest()).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'registers an http pusher once per app id and pushkey, lists it and removes it',
      async () => {
        const registered = pusher();
        const ids = { appId: registered.appId, pushkey: registered.pushkey };
        expect(await value(engine.pushers(alice))).toEqual([]);

        await ok(engine.setPusher(alice, registered));
        await ok(engine.setPusher(alice, registered));
        expect(await value(engine.pushers(alice))).toEqual([ids]);

        await ok(engine.removePusher(alice, ids.appId, ids.pushkey));
        expect(await value(engine.pushers(alice))).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'lists joined rooms with their names and DM flags, reporting an encrypted room as encrypted',
      async () => {
        const rooms = watch(engine.pushRooms(alice));
        const plainName = unique();
        const secretName = unique();
        const plain = await context.sharedRoom(plainName, false);
        const secret = await context.sharedRoom(secretName, true);
        await context.foreignAccountData('m.direct', {
          [context.bob]: [plain],
        });
        const find = (list: readonly PushRoom[], roomId: string) =>
          list.find((room) => room.roomId === roomId);

        const latest = await rooms.until(
          (list) =>
            find(list, plain)?.direct === true &&
            find(list, secret)?.name === secretName,
        );

        expect(find(latest, plain)).toMatchObject({
          roomId: plain,
          name: plainName,
          direct: true,
        });
        // Synapse's stubbed crypto never answers, so the plain room's flag is not pinned here;
        // the js-sdk adapter spec pins "encrypted until the crypto store answers".
        expect(find(latest, secret)).toEqual({
          roomId: secret,
          name: secretName,
          direct: false,
          encrypted: true,
        });
        for (const list of rooms.emissions) {
          expect(find(list, secret)?.encrypted ?? true).toBe(true);
        }
      },
      testTimeoutMs,
    );

    describe('incoming notifications', () => {
      const feeds: { unsubscribe(): void }[] = [];
      afterEach(() => {
        for (const feed of feeds.splice(0)) feed.unsubscribe();
      });

      /** A feed: nothing on subscribe, every item plain data. */
      function feed() {
        const recording = recordFeed(engine.notifications(alice));
        feeds.push(recording);
        return {
          ...recording,
          item: (eventId: string): Promise<IncomingNotification> =>
            recording.until(
              (item) => item.eventId === eventId,
              settleTimeoutMs,
            ),
        };
      }

      it(
        'emits a live message from someone else, and does not replay it to a later subscriber',
        async () => {
          const name = unique();
          const room = await context.sharedRoom(name, false);
          const first = feed();
          const firstId = await context.send(context.bob, room, 'first');

          expect(await first.item(firstId)).toEqual({
            kind: 'message',
            accountId: alice,
            roomId: room,
            eventId: firstId,
            senderId: context.bob,
            senderName: localpartOf(context.bob),
            roomName: name,
            body: 'first',
          });
          first.unsubscribe();

          const second = feed();
          const secondId = await context.send(context.bob, room, 'second');
          await second.item(secondId);
          expect(second.items.map((item) => item.eventId)).toEqual([secondId]);
        },
        testTimeoutMs,
      );

      it(
        'leaves out the account’s own messages',
        async () => {
          const room = await context.sharedRoom(unique(), false);
          const notifications = feed();
          await context.send(alice, room, 'mine');
          const theirs = await context.send(context.bob, room, 'theirs');

          await notifications.item(theirs);
          expect(notifications.items.map((item) => item.eventId)).toEqual([
            theirs,
          ]);
        },
        testTimeoutMs,
      );

      it(
        'leaves out a message the push rules silence, but not a reaction to it',
        async () => {
          const name = unique();
          const room = await context.sharedRoom(name, false);
          await ok(engine.setRoomMode(alice, room, 'mute'));
          const notifications = feed();
          const quiet = await context.send(context.bob, room, 'quiet');
          const reaction = await context.react(room, quiet, '👍');

          expect(await notifications.item(reaction)).toEqual({
            kind: 'reaction-annotation',
            accountId: alice,
            roomId: room,
            roomName: name,
            eventId: reaction,
            targetEventId: quiet,
            key: '👍',
            senderId: context.bob,
            senderName: localpartOf(context.bob),
          });
          expect(notifications.items.map((item) => item.eventId)).toEqual([
            reaction,
          ]);
        },
        testTimeoutMs,
      );

      it(
        'does not preview text that arrived in the clear in an encrypted room',
        async () => {
          const room = await context.sharedRoom(unique(), true);
          const notifications = feed();
          const clear = await context.send(context.bob, room, 'in the clear');

          expect(await notifications.item(clear)).toMatchObject({
            kind: 'message',
            eventId: clear,
            body: null,
          });
        },
        testTimeoutMs,
      );

      it(
        'finds the target of a reaction to an own message only, while a reaction is live',
        async () => {
          const room = await context.sharedRoom(unique(), false);
          const notifications = feed();
          const mine = await context.send(alice, room, 'mine');
          const theirs = await context.send(context.bob, room, 'theirs');
          const kept = await context.react(room, mine, '👍');
          const removed = await context.react(room, mine, '🎉');
          const other = await context.react(room, theirs, '👍');
          await notifications.item(other);
          expect(
            notifications.items.map((item) =>
              item.kind === 'reaction-annotation' ? item.targetEventId : null,
            ),
          ).toEqual([null, mine, mine, theirs]);

          expect(
            await value(
              engine.reactionTarget(alice, room, mine, [kept, removed]),
            ),
          ).toEqual({ body: 'mine', liveReactionIds: [kept, removed] });
          expect(
            await value(engine.reactionTarget(alice, room, theirs, [other])),
          ).toBeNull();

          await context.redact(room, removed);
          await eventually(
            () =>
              value(engine.reactionTarget(alice, room, mine, [kept, removed])),
            { body: 'mine', liveReactionIds: [kept] },
          );
          await context.redact(room, kept);
          await eventually(
            () =>
              value(engine.reactionTarget(alice, room, mine, [kept, removed])),
            null,
          );
        },
        testTimeoutMs,
      );
    });
  });
}
