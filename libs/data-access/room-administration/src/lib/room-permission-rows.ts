export type PermissionTargetKind = 'room' | 'space';
export type PermissionGroup = 'Messages' | 'Members' | 'Settings' | 'Rooms';
export type PermissionWrite =
  | {
      readonly kind: 'key';
      readonly key:
        | 'invite'
        | 'kick'
        | 'ban'
        | 'redact'
        | 'events_default'
        | 'state_default'
        | 'users_default';
    }
  | { readonly kind: 'notification'; readonly key: 'room' }
  | {
      readonly kind: 'event';
      readonly eventType: string;
      readonly state: boolean;
    };

export interface PermissionRow {
  readonly id: string;
  readonly label: string;
  readonly group: PermissionGroup;
  readonly writes: readonly PermissionWrite[];
}

export type PermissionLevel = number | 'mixed';
/** Loose by design: unknown keys must survive a round trip. */
export type PowerLevelsContent = Readonly<Record<string, unknown>>;

export const MAX_POWER_LEVEL = Number.MAX_SAFE_INTEGER;

type KeyName = Extract<PermissionWrite, { kind: 'key' }>['key'];

const KEY_DEFAULTS: Readonly<Record<KeyName, number>> = {
  invite: 0,
  kick: 50,
  ban: 50,
  redact: 50,
  events_default: 0,
  state_default: 50,
  users_default: 0,
};

const key = (name: KeyName): PermissionWrite => ({ kind: 'key', key: name });
const state = (eventType: string): PermissionWrite => ({
  kind: 'event',
  eventType,
  state: true,
});
const row = (
  id: string,
  label: string,
  group: PermissionGroup,
  ...writes: PermissionWrite[]
): PermissionRow => ({ id, label, group, writes });

const PROFILE = ['m.room.name', 'm.room.topic', 'm.room.avatar'].map(state);

const invite = row('invite', 'Invite', 'Members', key('invite'));
const kick = row('kick', 'Remove', 'Members', key('kick'));
const ban = row('ban', 'Ban', 'Members', key('ban'));
const usersDefault = row(
  'users-default',
  'New members start as',
  'Members',
  key('users_default'),
);
const profile = row('profile', 'Name, topic and photo', 'Settings', ...PROFILE);
const joinRule = row(
  'join-rule',
  'Join rule',
  'Settings',
  state('m.room.join_rules'),
);
const permissions = row(
  'permissions',
  'Change permissions',
  'Settings',
  state('m.room.power_levels'),
);
const stateDefault = row(
  'state-default',
  'Any other setting',
  'Settings',
  key('state_default'),
);

const ROOM_ROWS: readonly PermissionRow[] = [
  row('send-messages', 'Send messages', 'Messages', key('events_default')),
  row('send-reactions', 'Send reactions', 'Messages', {
    kind: 'event',
    eventType: 'm.reaction',
    state: false,
  }),
  row('redact', "Remove others' messages", 'Messages', key('redact')),
  row('mention-room', 'Mention everyone with @room', 'Messages', {
    kind: 'notification',
    key: 'room',
  }),
  row('pin', 'Pin messages', 'Messages', state('m.room.pinned_events')),
  invite,
  kick,
  ban,
  usersDefault,
  profile,
  joinRule,
  row(
    'history',
    'History visibility',
    'Settings',
    state('m.room.history_visibility'),
  ),
  row('addresses', 'Addresses', 'Settings', state('m.room.canonical_alias')),
  row('encryption', 'Encryption', 'Settings', state('m.room.encryption')),
  row('widgets', 'Widgets', 'Settings', state('im.vector.modular.widgets')),
  permissions,
  row('upgrade', 'Upgrade the room', 'Settings', state('m.room.tombstone')),
  stateDefault,
];

const SPACE_ROWS: readonly PermissionRow[] = [
  row(
    'space-children',
    'Manage rooms in this space',
    'Rooms',
    state('m.space.child'),
  ),
  invite,
  kick,
  ban,
  usersDefault,
  profile,
  joinRule,
  permissions,
  stateDefault,
];

export function permissionRows(
  kind: PermissionTargetKind,
): readonly PermissionRow[] {
  return kind === 'space' ? SPACE_ROWS : ROOM_ROWS;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

function readWrite(
  content: PowerLevelsContent,
  write: PermissionWrite,
): number {
  switch (write.kind) {
    case 'key':
      return integer(content[write.key], KEY_DEFAULTS[write.key]);
    case 'notification':
      return integer(record(content['notifications'])[write.key], 50);
    case 'event': {
      const fallback = integer(
        content[write.state ? 'state_default' : 'events_default'],
        KEY_DEFAULTS[write.state ? 'state_default' : 'events_default'],
      );
      return integer(record(content['events'])[write.eventType], fallback);
    }
  }
}

export function readRows(
  content: PowerLevelsContent,
  rows: readonly PermissionRow[],
): ReadonlyMap<string, PermissionLevel> {
  return new Map(
    rows.map((r) => {
      const levels = new Set(r.writes.map((w) => readWrite(content, w)));
      return [r.id, levels.size === 1 ? [...levels][0] : 'mixed'] as const;
    }),
  );
}

export function applyChanges(
  latest: PowerLevelsContent,
  rows: readonly PermissionRow[],
  changes: ReadonlyMap<string, number>,
): PowerLevelsContent {
  const next: Record<string, unknown> = structuredClone(latest) as Record<
    string,
    unknown
  >;
  const events: Record<string, unknown> = { ...record(next['events']) };
  const notifications: Record<string, unknown> = {
    ...record(next['notifications']),
  };
  for (const r of rows) {
    const level = changes.get(r.id);
    if (level === undefined) continue;
    for (const w of r.writes) {
      if (w.kind === 'key') next[w.key] = level;
      else if (w.kind === 'notification') notifications[w.key] = level;
      else events[w.eventType] = level;
    }
  }
  if (
    rows.some(
      (r) => changes.has(r.id) && r.writes.some((w) => w.kind === 'event'),
    )
  ) {
    next['events'] = events;
  }
  if (
    rows.some(
      (r) =>
        changes.has(r.id) && r.writes.some((w) => w.kind === 'notification'),
    )
  ) {
    next['notifications'] = notifications;
  }
  return next;
}
