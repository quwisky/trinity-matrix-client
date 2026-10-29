import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  ConditionKind,
  EventType,
  type IPusher,
  type IPushRule,
  type MatrixClient,
  type MatrixEvent,
  PushRuleActionName,
  type PushRuleAction,
  PushRuleKind as SdkPushRuleKind,
  RoomEvent,
  SyncState,
  TweakName,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
  RoomEncryptionFlags,
} from '@trinity/util/matrix';
import type {
  DefaultPushRule,
  HttpPusher,
  IncomingNotification,
  KeywordRule,
  NotificationEngine,
  NotificationPreference,
  NotificationSettings,
  PushRoom,
  PushRuleKind,
  ReactionTarget,
  RoomNotifyMode,
} from '../notification-engine';
import { JsSdkIncomingNotifications } from './js-sdk-incoming-notifications';
import {
  LEGACY_NOTIFICATION_SOUND_EVENT,
  LEGACY_REACTION_NOTIFICATION_EVENT,
  NOTIFICATION_SOUND_EVENT,
  REACTION_NOTIFICATION_EVENT,
  copyLegacyAccountData,
  enabledFlag,
} from './legacy-account-data';

const KINDS: readonly PushRuleKind[] = [
  'override',
  'content',
  'room',
  'sender',
  'underride',
];

const UNLOADED: NotificationSettings = {
  loaded: false,
  defaultRules: [],
  keywords: [],
  roomModes: {},
  sound: true,
  reactionNotifications: false,
};

const PREFERENCES: Record<
  NotificationPreference,
  { readonly type: string; readonly legacy: string; readonly fallback: boolean }
> = {
  sound: {
    type: NOTIFICATION_SOUND_EVENT,
    legacy: LEGACY_NOTIFICATION_SOUND_EVENT,
    fallback: true,
  },
  reactionNotifications: {
    type: REACTION_NOTIFICATION_EVENT,
    legacy: LEGACY_REACTION_NOTIFICATION_EVENT,
    fallback: false,
  },
};

const PREFERENCE_TYPES = new Set(
  Object.values(PREFERENCES).flatMap(({ type, legacy }) => [type, legacy]),
);

type RoomRuleKind = 'override' | 'room' | 'underride';

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

/**
 * Notify with the default sound, and highlight: the highlight colours the room in the list.
 * The actions are regenerated, never merged: a carried `dont_notify` would silence the word.
 */
const KEYWORD_ACTIONS: PushRuleAction[] = [
  PushRuleActionName.Notify,
  { set_tweak: TweakName.Sound, value: 'default' },
  { set_tweak: TweakName.Highlight },
];

/** Rust `get_notify_actions(true)`: an AllMessages room rule notifies with the default sound. */
const NOTIFY_ACTIONS: PushRuleAction[] = [
  PushRuleActionName.Notify,
  { set_tweak: TweakName.Sound, value: 'default' },
];

/** `request-failed`, with a refresh failure marked as the session's. */
function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

function rulesOf(client: MatrixClient, kind: PushRuleKind): readonly unknown[] {
  const list: unknown = (
    client.pushRules?.global as Record<string, unknown> | undefined
  )?.[kind];
  return Array.isArray(list) ? list : [];
}

/** A server-defined rule: the spec reserves a leading dot for them. */
function isServerRule(ruleId: string): boolean {
  return ruleId.startsWith('.');
}

function ruleIdOf(rule: unknown): string {
  const id: unknown = (rule as { rule_id?: unknown } | null)?.rule_id;
  return typeof id === 'string' ? id : '';
}

/**
 * The account's keyword rules, with the word each matches. Malformed rules (server or
 * another client's data) are skipped, so a bad rule never blanks the settings.
 */
function keywordRules(client: MatrixClient): {
  readonly ruleId: string;
  readonly pattern: string;
  readonly enabled: boolean;
}[] {
  return rulesOf(client, 'content').flatMap((value) => {
    const ruleId = ruleIdOf(value);
    const rule = value as Partial<IPushRule>;
    if (!ruleId || isServerRule(ruleId) || !Array.isArray(rule.actions)) {
      return [];
    }
    return [
      {
        ruleId,
        pattern: typeof rule.pattern === 'string' ? rule.pattern : ruleId,
        enabled: rule.enabled !== false,
      },
    ];
  });
}

interface RoomRule {
  readonly kind: RoomRuleKind;
  readonly ruleId: string;
  readonly enabled: boolean;
  readonly notifies: boolean;
  /** The rooms its `room_id` conditions match; a room rule's id is its room. */
  readonly rooms: readonly string[];
}

/** The account's own room, override and underride rules, with the rooms they match. */
function roomRules(client: MatrixClient): RoomRule[] {
  return (['override', 'room', 'underride'] as const).flatMap((kind) =>
    rulesOf(client, kind).flatMap((value): RoomRule[] => {
      const ruleId = ruleIdOf(value);
      if (!ruleId || isServerRule(ruleId)) return [];
      const rule = value as Partial<IPushRule>;
      const conditions: unknown[] = Array.isArray(rule.conditions)
        ? rule.conditions
        : [];
      const rooms = conditions.flatMap((entry) => {
        const condition = entry as {
          kind?: unknown;
          key?: unknown;
          pattern?: unknown;
        } | null;
        return condition?.kind === ConditionKind.EventMatch &&
          condition.key === 'room_id' &&
          typeof condition.pattern === 'string'
          ? [condition.pattern]
          : [];
      });
      return [
        {
          kind,
          ruleId,
          enabled: rule.enabled !== false,
          notifies:
            Array.isArray(rule.actions) &&
            rule.actions.includes(PushRuleActionName.Notify),
          rooms: kind === 'room' ? [ruleId] : rooms,
        },
      ];
    }),
  );
}

/** Rust `get_custom_rules_for_room`: keyed by the room or matching it. */
function matchesRoom(rule: RoomRule, roomId: string): boolean {
  return rule.ruleId === roomId || rule.rooms.includes(roomId);
}

/**
 * Rust `get_user_defined_room_notification_mode` (counting enabled rules only): null when the
 * room has no rule that sets a mode, `all` for an enabled notifying room rule.
 */
function userDefinedMode(
  client: MatrixClient,
  roomId: string,
): RoomNotifyMode | null {
  const mode = roomModesOf(client)[roomId];
  if (mode) return mode;
  return roomRules(client).some(
    (rule) => rule.kind === 'room' && rule.ruleId === roomId && rule.enabled,
  )
    ? 'all'
    : null;
}

function roomModesOf(
  client: MatrixClient,
): Record<string, Exclude<RoomNotifyMode, 'all'>> {
  const modes: Record<string, Exclude<RoomNotifyMode, 'all'>> = {};
  for (const rule of roomRules(client)) {
    if (!rule.enabled || rule.notifies) continue;
    for (const roomId of rule.rooms) {
      if (rule.kind === 'override') modes[roomId] = 'mute';
      else if (rule.kind === 'room') modes[roomId] ??= 'mentions';
    }
  }
  return modes;
}

function preferencesOf(
  client: MatrixClient,
): Pick<NotificationSettings, 'sound' | 'reactionNotifications'> {
  const flag = (preference: NotificationPreference): boolean => {
    const { type, legacy, fallback } = PREFERENCES[preference];
    return enabledFlag(client as never, type, legacy, fallback);
  };
  return {
    sound: flag('sound'),
    reactionNotifications: flag('reactionNotifications'),
  };
}

/**
 * Copies each retired preference name to its current one when only the old one exists. Runs
 * on every publish of a `settings` subscription, inside the SDK's emit loop, so a throw must
 * never escape; a failed write is retried at the next publish.
 */
function copyRetiredPreferences(client: MatrixClient): void {
  try {
    for (const { type, legacy } of Object.values(PREFERENCES)) {
      copyLegacyAccountData(client as never, type, legacy);
    }
  } catch {
    /* the old value stays readable; the next publish retries (an m.push_rules or preference
       account-data event, a sync before the rules load, or a command's re-read) */
  }
}

function settingsOf(client: MatrixClient | null): NotificationSettings {
  if (!client) return UNLOADED;
  if (!client.pushRules?.global) {
    return { ...UNLOADED, ...preferencesOf(client) };
  }
  const defaultRules = KINDS.flatMap((kind) =>
    rulesOf(client, kind).flatMap((rule): DefaultPushRule[] => {
      const ruleId = ruleIdOf(rule);
      return isServerRule(ruleId)
        ? [{ ruleId, kind, enabled: (rule as IPushRule).enabled === true }]
        : [];
    }),
  );
  const words = new Map<string, boolean>();
  for (const { pattern, enabled } of keywordRules(client)) {
    words.set(pattern, !!words.get(pattern) || enabled);
  }
  return {
    loaded: true,
    defaultRules,
    keywords: [...words].map(([pattern, enabled]): KeywordRule => ({
      pattern,
      enabled,
    })),
    roomModes: roomModesOf(client),
    ...preferencesOf(client),
  };
}

/** Room ids the `m.direct` account data lists as DMs. */
function directRoomIds(client: MatrixClient): ReadonlySet<string> {
  const map =
    client
      .getAccountData(EventType.Direct)
      ?.getContent<Record<string, unknown>>() ?? {};
  const ids = new Set<string>();
  for (const roomIds of Object.values(map)) {
    if (!Array.isArray(roomIds)) continue;
    for (const roomId of roomIds) {
      if (typeof roomId === 'string') ids.add(roomId);
    }
  }
  return ids;
}

/** {@link NotificationEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkNotificationEngine implements NotificationEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  /** A client whose rules a command has just re-read. */
  private readonly refreshed = new Subject<MatrixClient>();
  /** Each account's last room-mode write: the next one snapshots the rules after it. */
  private readonly roomModeWrites = new Map<string, Promise<unknown>>();
  private readonly incoming = new JsSdkIncomingNotifications();

  settings(accountId: string): Observable<NotificationSettings> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(UNLOADED), NEVER);
      return new Observable<NotificationSettings>((subscriber) => {
        const onSync = (): void => queued.schedule();
        const publish = (): void => {
          if (this.clients.clientFor(accountId) !== client) return;
          copyRetiredPreferences(client);
          const settings = settingsOf(client);
          // Later changes arrive as m.push_rules account data.
          if (settings.loaded) client.off(ClientEvent.Sync, onSync);
          subscriber.next(settings);
        };
        const queued = coalesce(publish);
        const onAccountData = (event: MatrixEvent): void => {
          const type = event.getType();
          if (type === 'm.push_rules' || PREFERENCE_TYPES.has(type)) {
            queued.schedule();
          }
        };
        // The rules fetched before the first sync arrive without an account-data event.
        client.on(ClientEvent.Sync, onSync);
        client.on(ClientEvent.AccountData, onAccountData);
        const commands = this.refreshed.subscribe((target) => {
          if (target === client) publish();
        });
        publish();
        return () => {
          queued.cancel();
          commands.unsubscribe();
          client.off(ClientEvent.Sync, onSync);
          client.off(ClientEvent.AccountData, onAccountData);
        };
      }).pipe(distinctUntilChanged<NotificationSettings>(plainEqual));
    });
  }

  setPushRulesEnabled(
    accountId: string,
    rules: readonly { readonly ruleId: string; readonly kind: PushRuleKind }[],
    enabled: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      Promise.all(
        rules.map(({ ruleId, kind }) =>
          client.setPushRuleEnabled(
            'global',
            kind as SdkPushRuleKind,
            ruleId,
            enabled,
          ),
        ),
      ),
    );
  }

  setKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      const rules = keywordRules(client);
      const existing = rules.filter((rule) => rule.pattern === pattern);
      if (existing.length === 0) {
        // The id may already hold a rule for another spelling; the PUT keeps its enabled flag.
        const taken = rules.find((rule) => rule.ruleId === pattern);
        await client.addPushRule(
          'global',
          SdkPushRuleKind.ContentSpecific,
          pattern,
          { pattern, actions: KEYWORD_ACTIONS },
        );
        if (taken && !taken.enabled) {
          await client.setPushRuleEnabled(
            'global',
            SdkPushRuleKind.ContentSpecific,
            pattern,
            true,
          );
        }
      } else if (!existing.some((rule) => rule.enabled)) {
        // Rewritten too: another client's rule may carry other actions.
        await client.addPushRule(
          'global',
          SdkPushRuleKind.ContentSpecific,
          existing[0].ruleId,
          { pattern, actions: KEYWORD_ACTIONS },
        );
        await client.setPushRuleEnabled(
          'global',
          SdkPushRuleKind.ContentSpecific,
          existing[0].ruleId,
          true,
        );
      }
    });
  }

  removeKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      Promise.all(
        keywordRules(client)
          .filter((rule) => rule.pattern === pattern)
          .map((rule) =>
            client.deletePushRule(
              'global',
              SdkPushRuleKind.ContentSpecific,
              rule.ruleId,
            ),
          ),
      ),
    );
  }

  setRoomMode(
    accountId: string,
    roomId: string,
    mode: RoomNotifyMode,
  ): Observable<EngineResult<null>> {
    // The re-read is queued too, so a later write's reply never precedes an earlier re-read.
    return this.request(accountId, (client) =>
      this.serializeRoomModes(accountId, () =>
        this.writeAndRefresh(client, () =>
          this.writeRoomMode(client, roomId, mode),
        ),
      ),
    );
  }

  private serializeRoomModes<T>(
    accountId: string,
    write: () => Promise<T>,
  ): Promise<T> {
    const next = (this.roomModeWrites.get(accountId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(write);
    this.roomModeWrites.set(accountId, next);
    void next
      .finally(() => {
        if (this.roomModeWrites.get(accountId) === next) {
          this.roomModeWrites.delete(accountId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  private async writeRoomMode(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    // The cache can lag another device's write; replace what the server holds.
    await client.getPushRules();
    if (userDefinedMode(client, roomId) === mode) return;
    const kind = mode === 'mute' ? 'override' : 'room';
    const rules = roomRules(client);
    await client.addPushRule('global', kind as SdkPushRuleKind, roomId, {
      actions: mode === 'all' ? NOTIFY_ACTIONS : [],
      ...(kind === 'override'
        ? {
            conditions: [
              {
                kind: ConditionKind.EventMatch,
                key: 'room_id',
                pattern: roomId,
              },
            ],
          }
        : {}),
    });
    // The PUT keeps an existing rule's enabled flag (Rust leaves it off).
    const overwritten = rules.find(
      (rule) => rule.kind === kind && rule.ruleId === roomId,
    );
    if (overwritten && !overwritten.enabled) {
      await client.setPushRuleEnabled(
        'global',
        kind as SdkPushRuleKind,
        roomId,
        true,
      );
    }
    for (const rule of rules) {
      if (
        matchesRoom(rule, roomId) &&
        !(rule.kind === kind && rule.ruleId === roomId)
      ) {
        await client.deletePushRule(
          'global',
          rule.kind as SdkPushRuleKind,
          rule.ruleId,
        );
      }
    }
  }

  readRoomMode(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<RoomNotifyMode>> {
    return this.request(accountId, async (client) => {
      await client.getPushRules();
      this.refreshed.next(client);
      return roomModesOf(client)[roomId] ?? 'all';
    });
  }

  setPreference(
    accountId: string,
    preference: NotificationPreference,
    on: boolean,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      const { type } = PREFERENCES[preference];
      const write = (): Promise<unknown> =>
        client.setAccountData(type as never, { enabled: on } as never);
      // Resolves on the next echo of `type`, which can be an earlier write's, such as the
      // retired-name copy's: write again once the store holds that one.
      await write();
      const stored = client.getAccountData(type as never)?.getContent() as
        { enabled?: unknown } | undefined;
      if (stored?.enabled !== on) await write();
      this.refreshed.next(client);
      return null;
    });
  }

  notifications(accountId: string): Observable<IncomingNotification> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      return client
        ? this.incoming.feed(
            accountId,
            client,
            () => this.clients.clientFor(accountId) === client,
          )
        : NEVER;
    });
  }

  reactionTarget(
    accountId: string,
    roomId: string,
    targetEventId: string,
    reactionIds: readonly string[],
  ): Observable<EngineResult<ReactionTarget | null>> {
    return this.request(accountId, (client) =>
      this.incoming.target(
        accountId,
        client,
        roomId,
        targetEventId,
        reactionIds,
      ),
    );
  }

  setPusher(
    accountId: string,
    pusher: HttpPusher,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.setPusher({
        app_id: pusher.appId,
        pushkey: pusher.pushkey,
        kind: 'http',
        app_display_name: pusher.appDisplayName,
        device_display_name: client.getDeviceId() ?? 'Trinity',
        lang: pusher.lang,
        // The spec allows extra `data` keys; the SDK types the field narrowly.
        data: {
          url: pusher.url,
          ...(pusher.format ? { format: pusher.format } : {}),
          ...pusher.data,
        } as IPusher['data'],
        // Every account shares the device's pushkey: `false` would make each co-hosted
        // account's pusher replace the previous one's (Synapse).
        append: true,
      });
      return null;
    });
  }

  removePusher(
    accountId: string,
    appId: string,
    pushkey: string,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.removePusher(pushkey, appId);
      return null;
    });
  }

  pushers(
    accountId: string,
  ): Observable<
    EngineResult<
      readonly { readonly appId: string; readonly pushkey: string }[]
    >
  > {
    return this.request(accountId, async (client) =>
      (await client.getPushers()).pushers.map((pusher) => ({
        appId: pusher.app_id,
        pushkey: pusher.pushkey,
      })),
    );
  }

  pushRooms(accountId: string): Observable<readonly PushRoom[]> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of([]), NEVER);
      return new Observable<readonly PushRoom[]>((subscriber) => {
        const encryption = new RoomEncryptionFlags();
        const publish = (): void => {
          if (
            subscriber.closed ||
            this.clients.clientFor(accountId) !== client
          ) {
            return;
          }
          const direct = directRoomIds(client);
          const rooms: PushRoom[] = [];
          for (const room of client.getRooms()) {
            if (room.getMyMembership() !== 'join') continue;
            const answered = encryption.answered(room.roomId);
            if (!answered) {
              void encryption
                .refresh(client.getCrypto(), room.roomId)
                .then(() => {
                  if (encryption.answered(room.roomId)) publish();
                });
            }
            rooms.push({
              roomId: room.roomId,
              name: room.name,
              direct: direct.has(room.roomId),
              // Until the crypto store answers, the room may be encrypted without saying so in
              // its state; the renderers would show unencrypted text from it as a member's.
              encrypted: !answered || encryption.isEncrypted(room),
            });
          }
          subscriber.next(rooms);
        };
        const onSync = (state: SyncState): void => {
          if (state === SyncState.Prepared || state === SyncState.Syncing) {
            publish();
          }
        };
        const onAccountData = (event: MatrixEvent): void => {
          if (event.getType() === EventType.Direct) publish();
        };
        client.on(ClientEvent.Sync, onSync);
        client.on(RoomEvent.Name, publish);
        client.on(ClientEvent.AccountData, onAccountData);
        publish();
        return () => {
          client.off(ClientEvent.Sync, onSync);
          client.off(RoomEvent.Name, publish);
          client.off(ClientEvent.AccountData, onAccountData);
        };
      });
    });
  }

  /**
   * Runs `write`, re-reads the rules and publishes them to `settings` before replying, so the
   * reply never precedes its effect. A failed re-read leaves the rules to the sync echo: the
   * write has landed, and reporting it as failed would invite a retry that 404s.
   */
  private command(
    accountId: string,
    write: (client: MatrixClient) => Promise<unknown>,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, (client) =>
      this.writeAndRefresh(client, () => write(client)),
    );
  }

  private async writeAndRefresh(
    client: MatrixClient,
    write: () => Promise<unknown>,
  ): Promise<null> {
    try {
      await write();
    } finally {
      // Also after a partial failure: some of the writes may have landed.
      await client.getPushRules().catch(() => undefined);
      this.refreshed.next(client);
    }
    return null;
  }

  private request<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(run(client)).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }
}
