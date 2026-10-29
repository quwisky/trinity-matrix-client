import {
  NEVER,
  type Observable,
  Subject,
  defer,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  DefaultPushRule,
  IncomingNotification,
  KeywordRule,
  NotificationEngine,
  NotificationPreference,
  NotificationSettings,
  PushRuleKind,
  ReactionTarget,
  RoomNotifyMode,
} from '../lib/notification-engine';
import type { ServerRoomRule } from './notification-engine.contract';

interface FakeKeywordRule {
  readonly ruleId: string;
  readonly pattern: string;
  enabled: boolean;
  actions: unknown[];
}

const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

interface FakeEvent {
  readonly sender: string;
  /** A message's text, or a reaction's target. */
  readonly body: string;
  readonly reaction: boolean;
  redacted: boolean;
}

interface FakeRoom {
  readonly name: string;
  readonly encrypted: boolean;
  readonly events: Map<string, FakeEvent>;
}

/** As Synapse names a registered user: its localpart. */
function localpartOf(userId: string): string {
  return userId.slice(1).split(':')[0];
}

interface FakeRoomRule {
  readonly kind: 'override' | 'room' | 'underride';
  readonly ruleId: string;
  enabled: boolean;
  readonly actions: unknown[];
  readonly conditions?: unknown[];
}

const PREFERENCES: Record<
  NotificationPreference,
  { readonly type: string; readonly legacy: string; readonly fallback: boolean }
> = {
  sound: {
    type: 'dev.trinityproject.trinity.notification_sound',
    legacy: 'eu.qwky.trinity.notification_sound',
    fallback: true,
  },
  reactionNotifications: {
    type: 'dev.trinityproject.trinity.reaction_notifications',
    legacy: 'eu.qwky.trinity.reaction_notifications',
    fallback: false,
  },
};

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const NOT_FOUND: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404, errcode: 'M_NOT_FOUND' },
};

const UNLOADED: NotificationSettings = {
  loaded: false,
  defaultRules: [],
  keywords: [],
  roomModes: {},
  sound: true,
  reactionNotifications: false,
};

function matchesRoom(rule: FakeRoomRule, roomId: string): boolean {
  return (
    rule.ruleId === roomId ||
    (rule.conditions ?? []).some(
      (condition) =>
        (condition as { kind?: unknown }).kind === 'event_match' &&
        (condition as { key?: unknown }).key === 'room_id' &&
        (condition as { pattern?: unknown }).pattern === roomId,
    )
  );
}

function roomIdOf(rule: FakeRoomRule): string | undefined {
  if (rule.kind === 'room') return rule.ruleId;
  const condition = (rule.conditions ?? []).find(
    (entry) =>
      (entry as { kind?: unknown }).kind === 'event_match' &&
      (entry as { key?: unknown }).key === 'room_id',
  ) as { pattern?: unknown } | undefined;
  return typeof condition?.pattern === 'string' ? condition.pattern : undefined;
}

/**
 * An in-memory {@link NotificationEngine}. {@link alice} is live and has settings; {@link live}
 * lists the accounts whose feeds and commands work. Messages notify every other live account
 * unless the one ruleset mutes the room or the master rule is on.
 */
export class FakeNotificationEngine implements NotificationEngine {
  private readonly defaults: DefaultPushRule[] = [
    { ruleId: '.m.rule.master', kind: 'override', enabled: false },
    { ruleId: '.m.rule.invite_for_me', kind: 'override', enabled: true },
    { ruleId: '.m.rule.is_user_mention', kind: 'override', enabled: true },
    { ruleId: '.m.rule.contains_user_name', kind: 'content', enabled: true },
    { ruleId: '.m.rule.message', kind: 'underride', enabled: true },
  ];
  /** Server order: a rule written without `before`/`after` goes first. */
  private keywordRules: FakeKeywordRule[] = [];
  private roomRules: FakeRoomRule[] = [];
  private readonly accountData = new Map<string, object>();
  private readonly changes = new Subject<void>();
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly incoming = new Subject<IncomingNotification>();
  private readonly openFeeds = new Map<string, number>();
  private sequence = 0;

  readonly alice = '@alice:fake';
  readonly bob = '@bob:fake';
  /** Accounts with a live client; add more for a multi-account test. */
  readonly live = new Set([this.alice]);

  /**
   * A room every live account and bob are in, encrypted by its state when asked. The fake sends
   * nothing encrypted, so no text is previewed there.
   */
  createRoom(
    name: string,
    options: { readonly encrypted?: boolean; readonly roomId?: string } = {},
  ): string {
    const roomId = options.roomId ?? `!room${++this.sequence}:fake`;
    this.rooms.set(roomId, {
      name,
      encrypted: options.encrypted ?? false,
      events: new Map(),
    });
    return roomId;
  }

  /** `sender` sends a text message, live; returns its event id. */
  send(sender: string, roomId: string, body: string): string {
    const room = this.room(roomId);
    const eventId = this.store(room, { sender, body, reaction: false });
    const notifies =
      !this.roomModes()[roomId] &&
      !this.defaults.find((rule) => rule.ruleId === '.m.rule.master')?.enabled;
    for (const accountId of this.live) {
      if (accountId === sender || !notifies) continue;
      this.deliver({
        kind: 'message',
        accountId,
        roomId,
        eventId,
        senderId: sender,
        senderName: localpartOf(sender),
        roomName: room.name,
        body: room.encrypted ? null : body,
      });
    }
    return eventId;
  }

  /** `sender` reacts to `targetEventId` with `key`, live; returns the reaction's event id. */
  react(
    sender: string,
    roomId: string,
    targetEventId: string,
    key: string,
  ): string {
    const room = this.room(roomId);
    const eventId = this.store(room, {
      sender,
      body: targetEventId,
      reaction: true,
    });
    for (const accountId of this.live) {
      if (accountId === sender) continue;
      this.deliver({
        kind: 'reaction-annotation',
        accountId,
        roomId,
        roomName: room.name,
        eventId,
        targetEventId,
        key,
        senderId: sender,
        senderName: localpartOf(sender),
      });
    }
    return eventId;
  }

  redact(roomId: string, eventId: string): void {
    const event = this.room(roomId).events.get(eventId);
    if (event) event.redacted = true;
  }

  /** Hands `item` to its account's open feeds as it is; an annotation's reaction becomes live. */
  deliver(item: IncomingNotification): void {
    const events = this.rooms.get(item.roomId)?.events;
    if (item.kind === 'reaction-annotation' && !events?.has(item.eventId)) {
      events?.set(item.eventId, {
        sender: item.senderId,
        body: item.targetEventId,
        reaction: true,
        redacted: false,
      });
    }
    this.incoming.next(item);
  }

  /** How many `notifications` subscriptions of the account are open. */
  feeds(accountId: string): number {
    return this.openFeeds.get(accountId) ?? 0;
  }

  /**
   * Another client PUTs the content rule `ruleId`, then switches it off unless `enabled`, as a
   * sync would deliver it. Like Synapse, a PUT over an existing rule keeps its enabled flag.
   */
  writeKeywordRule(
    ruleId: string,
    pattern: string,
    enabled = true,
    actions: unknown[] = ['notify'],
  ): void {
    const kept =
      this.keywordRules.find((rule) => rule.ruleId === ruleId)?.enabled ?? true;
    this.keywordRules = [
      { ruleId, pattern, enabled: kept && enabled, actions },
      ...this.keywordRules.filter((rule) => rule.ruleId !== ruleId),
    ];
    this.changes.next();
  }

  /** Another client PUTs a room-scoped rule; like Synapse, a PUT keeps an existing rule's enabled flag. */
  writeRoomRule(
    kind: FakeRoomRule['kind'],
    ruleId: string,
    rule: { readonly actions: unknown[]; readonly conditions?: unknown[] },
    enabled = true,
  ): void {
    this.putRoomRule(kind, ruleId, rule, enabled);
    this.changes.next();
  }

  /** The server's rules keyed by or matching `roomId`, sorted by kind and id. */
  serverRoomRules(roomId: string): ServerRoomRule[] {
    return this.roomRules
      .filter((rule) => matchesRoom(rule, roomId))
      .map(({ kind, ruleId, enabled, actions }) => ({
        kind,
        ruleId,
        enabled,
        actions: structuredClone(actions),
      }))
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || a.ruleId.localeCompare(b.ruleId),
      );
  }

  /** Another client writes account data. */
  writeAccountData(type: string, content: object): void {
    this.accountData.set(type, structuredClone(content));
    this.changes.next();
  }

  /** The account data of `type` as the server holds it. */
  readAccountData(type: string): unknown {
    const content = this.accountData.get(type);
    return content ? structuredClone(content) : undefined;
  }

  /** Replaces the server-defined rules, as a homeserver variant ships them. */
  defineDefaultRules(rules: readonly DefaultPushRule[]): void {
    this.defaults.splice(0, this.defaults.length, ...rules);
    this.changes.next();
  }

  /** The stored actions of content rule `ruleId`, as the server holds them. */
  keywordActions(ruleId: string): unknown {
    const rule = this.keywordRules.find((entry) => entry.ruleId === ruleId);
    return rule ? structuredClone(rule.actions) : undefined;
  }

  settings(accountId: string): Observable<NotificationSettings> {
    return this.changes.pipe(
      startWith(undefined),
      map(() => {
        if (accountId !== this.alice) return UNLOADED;
        this.copyLegacyPreferences();
        return this.snapshot();
      }),
      distinctUntilChanged<NotificationSettings>(plainEqual),
    );
  }

  setPushRulesEnabled(
    accountId: string,
    rules: readonly { readonly ruleId: string; readonly kind: PushRuleKind }[],
    enabled: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const targets = rules.map((target) =>
        this.defaults.findIndex(
          (rule) => rule.ruleId === target.ruleId && rule.kind === target.kind,
        ),
      );
      if (targets.includes(-1)) return engineFail(NOT_FOUND);
      for (const index of targets) {
        this.defaults[index] = { ...this.defaults[index], enabled };
      }
      this.changes.next();
      return engineOk(null);
    });
  }

  setKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const existing = this.keywordRules.filter(
        (rule) => rule.pattern === pattern,
      );
      if (existing.length === 0) {
        this.writeKeywordRule(pattern, pattern, true, KEYWORD_ACTIONS);
        const written = this.keywordRules[0];
        if (!written.enabled) {
          written.enabled = true;
          this.changes.next();
        }
      } else if (!existing.some((rule) => rule.enabled)) {
        existing[0].enabled = true;
        existing[0].actions = KEYWORD_ACTIONS;
        this.changes.next();
      }
      return engineOk(null);
    });
  }

  removeKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.keywordRules = this.keywordRules.filter(
        (rule) => rule.pattern !== pattern,
      );
      this.changes.next();
      return engineOk(null);
    });
  }

  setRoomMode(
    accountId: string,
    roomId: string,
    mode: RoomNotifyMode,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      if (this.userDefinedMode(roomId) === mode) return engineOk(null);
      const kept = mode === 'mute' ? 'override' : 'room';
      this.putRoomRule(
        kept,
        roomId,
        {
          actions:
            mode === 'all'
              ? ['notify', { set_tweak: 'sound', value: 'default' }]
              : [],
          ...(kept === 'override'
            ? {
                conditions: [
                  { kind: 'event_match', key: 'room_id', pattern: roomId },
                ],
              }
            : {}),
        },
        true,
      );
      this.roomRules[0].enabled = true;
      this.roomRules = this.roomRules.filter(
        (rule) =>
          !matchesRoom(rule, roomId) ||
          (rule.kind === kept && rule.ruleId === roomId),
      );
      this.changes.next();
      return engineOk(null);
    });
  }

  readRoomMode(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<RoomNotifyMode>> {
    return defer(() =>
      of(
        accountId === this.alice
          ? engineOk(this.modeOf(roomId))
          : engineFail(NOT_LIVE),
      ),
    );
  }

  setPreference(
    accountId: string,
    preference: NotificationPreference,
    on: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.writeAccountData(PREFERENCES[preference].type, { enabled: on });
      return engineOk(null);
    });
  }

  notifications(accountId: string): Observable<IncomingNotification> {
    return defer(() => {
      if (!this.live.has(accountId)) return NEVER;
      this.openFeeds.set(accountId, this.feeds(accountId) + 1);
      return this.incoming.pipe(
        filter((item) => item.accountId === accountId),
        finalize(() =>
          this.openFeeds.set(accountId, this.feeds(accountId) - 1),
        ),
      );
    });
  }

  reactionTarget(
    accountId: string,
    roomId: string,
    targetEventId: string,
    reactionIds: readonly string[],
  ): Observable<EngineResult<ReactionTarget | null>> {
    return defer(() => {
      if (!this.live.has(accountId)) return of(engineFail(NOT_LIVE));
      const room = this.rooms.get(roomId);
      const target = room?.events.get(targetEventId);
      const liveReactionIds = reactionIds.filter((id) => {
        const reaction = room?.events.get(id);
        return reaction?.reaction === true && !reaction.redacted;
      });
      return of(
        engineOk(
          room &&
            target &&
            !target.reaction &&
            !target.redacted &&
            target.sender === accountId &&
            liveReactionIds.length > 0
            ? {
                body: room.encrypted ? null : target.body,
                liveReactionIds,
              }
            : null,
        ),
      );
    });
  }

  private room(roomId: string): FakeRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`No fake room ${roomId}`);
    return room;
  }

  private store(room: FakeRoom, event: Omit<FakeEvent, 'redacted'>): string {
    const eventId = `$event${++this.sequence}`;
    room.events.set(eventId, { ...event, redacted: false });
    return eventId;
  }

  private putRoomRule(
    kind: FakeRoomRule['kind'],
    ruleId: string,
    rule: { readonly actions: unknown[]; readonly conditions?: unknown[] },
    enabled: boolean,
  ): void {
    const kept =
      this.roomRules.find(
        (entry) => entry.kind === kind && entry.ruleId === ruleId,
      )?.enabled ?? true;
    this.roomRules = [
      {
        kind,
        ruleId,
        enabled: kept && enabled,
        actions: structuredClone([...rule.actions]),
        ...(rule.conditions
          ? { conditions: structuredClone([...rule.conditions]) }
          : {}),
      },
      ...this.roomRules.filter(
        (entry) => !(entry.kind === kind && entry.ruleId === ruleId),
      ),
    ];
  }

  private roomModes(): Record<string, Exclude<RoomNotifyMode, 'all'>> {
    const modes: Record<string, Exclude<RoomNotifyMode, 'all'>> = {};
    for (const rule of this.roomRules) {
      const roomId = roomIdOf(rule);
      if (roomId && rule.enabled && !rule.actions.includes('notify')) {
        if (rule.kind === 'override') modes[roomId] = 'mute';
        else if (rule.kind === 'room') modes[roomId] ??= 'mentions';
      }
    }
    return modes;
  }

  /** Rust `get_user_defined_room_notification_mode`, counting enabled rules only. */
  private userDefinedMode(roomId: string): RoomNotifyMode | null {
    const mode = this.roomModes()[roomId];
    if (mode) return mode;
    return this.roomRules.some(
      (rule) => rule.kind === 'room' && rule.ruleId === roomId && rule.enabled,
    )
      ? 'all'
      : null;
  }

  private modeOf(roomId: string): RoomNotifyMode {
    return this.roomModes()[roomId] ?? 'all';
  }

  private preference(preference: NotificationPreference): boolean {
    const { type, legacy, fallback } = PREFERENCES[preference];
    const enabled = (
      (this.accountData.get(type) ?? this.accountData.get(legacy)) as
        { enabled?: unknown } | undefined
    )?.enabled;
    return typeof enabled === 'boolean' ? enabled : fallback;
  }

  /** As the js-sdk engine does while subscribed; the snapshot reads the same either way. */
  private copyLegacyPreferences(): void {
    for (const { type, legacy } of Object.values(PREFERENCES)) {
      const old = this.accountData.get(legacy);
      if (old && !this.accountData.has(type)) this.accountData.set(type, old);
    }
  }

  private snapshot(): NotificationSettings {
    const keywords = new Map<string, boolean>();
    for (const rule of this.keywordRules) {
      keywords.set(rule.pattern, !!keywords.get(rule.pattern) || rule.enabled);
    }
    return {
      loaded: true,
      defaultRules: this.defaults.map((rule) => ({ ...rule })),
      keywords: [...keywords].map(([pattern, enabled]): KeywordRule => ({
        pattern,
        enabled,
      })),
      roomModes: this.roomModes(),
      sound: this.preference('sound'),
      reactionNotifications: this.preference('reactionNotifications'),
    };
  }

  private command(
    accountId: string,
    run: () => EngineResult<null>,
  ): Observable<EngineResult<null>> {
    return defer(() =>
      of(accountId === this.alice ? run() : engineFail(NOT_LIVE)),
    );
  }
}
