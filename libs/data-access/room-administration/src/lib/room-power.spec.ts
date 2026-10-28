import { MatrixEvent, RoomState } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import type {
  JsonObject,
  Membership,
  PowerLevel,
} from './room-administration-engine';
import {
  type PowerAction,
  mayAct,
  mayRedactEvent,
  maySendEvent,
  maySendState,
  powerValue,
} from './room-power';

const ROOM = '!room:example.org';
const CREATOR = '@creator:example.org';
const CO_CREATOR = '@co:example.org';
const MODERATOR = '@mod:example.org';
const MEMBER = '@member:example.org';
const BANNED = '@banned:example.org';
const LEFT = '@left:example.org';
const OUTSIDER = '@outsider:example.org';

interface Fixture {
  readonly name: string;
  readonly version: string;
  readonly additionalCreators?: readonly string[];
  readonly powerLevels: JsonObject | null;
}

const FIXTURES: readonly Fixture[] = [
  { name: 'no power levels event', version: '10', powerLevels: null },
  {
    name: 'a preset power levels event',
    version: '10',
    powerLevels: {
      users: { [CREATOR]: 100, [MODERATOR]: 50 },
      users_default: 0,
      events: {
        'm.room.pinned_events': 50,
        'm.room.message': 10,
        'm.room.redaction': 0,
        'm.space.child': 50,
      },
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
    },
  },
  {
    name: 'malformed and missing keys',
    version: '11',
    powerLevels: {
      users: { [MODERATOR]: 50, [MEMBER]: 2.5 },
      users_default: 10,
      events: {
        'm.room.name': 5.5,
        'm.room.topic': '0',
        'm.room.pinned_events': 0,
        'm.room.redaction': 60,
      },
      events_default: '20',
      kick: 0,
      ban: '75',
      redact: 1.5,
      invite: 10,
    },
  },
  {
    name: 'a v12 room with an additional creator',
    version: '12',
    additionalCreators: [CO_CREATOR],
    powerLevels: {
      users: { [MODERATOR]: 50 },
      events: { 'm.room.power_levels': 150, 'm.room.tombstone': 150 },
      state_default: 100,
      events_default: 0,
      kick: 100,
      ban: 100,
      redact: 100,
      invite: 100,
    },
  },
  {
    name: 'a v12 room without a power levels event',
    version: '12',
    additionalCreators: [CO_CREATOR],
    powerLevels: null,
  },
];

const USERS = [CREATOR, CO_CREATOR, MODERATOR, MEMBER, BANNED, LEFT, OUTSIDER];
const STATE_TYPES = [
  'm.room.name',
  'm.room.topic',
  'm.room.power_levels',
  'm.room.pinned_events',
  'm.room.tombstone',
  'm.space.child',
  'org.example.custom',
];
const EVENT_TYPES = ['m.room.message', 'm.room.redaction', 'm.reaction'];
const ACTIONS: readonly PowerAction[] = ['invite', 'kick', 'ban', 'redact'];

let nextEvent = 0;

function stateEvent(
  type: string,
  stateKey: string,
  sender: string,
  content: Record<string, unknown>,
): MatrixEvent {
  return new MatrixEvent({
    type,
    state_key: stateKey,
    sender,
    room_id: ROOM,
    event_id: `$state-${++nextEvent}`,
    origin_server_ts: 1,
    content,
  });
}

function member(userId: string, membership: Membership): MatrixEvent {
  return stateEvent('m.room.member', userId, userId, { membership });
}

/** js-sdk's own view of the fixture: the authority the rules must match. */
function roomStateFor(fixture: Fixture): RoomState {
  const state = new RoomState(ROOM);
  state.setStateEvents([
    stateEvent('m.room.create', '', CREATOR, {
      room_version: fixture.version,
      ...(fixture.additionalCreators
        ? { additional_creators: fixture.additionalCreators }
        : {}),
    }),
    ...(fixture.powerLevels
      ? [stateEvent('m.room.power_levels', '', CREATOR, fixture.powerLevels)]
      : []),
    member(CREATOR, 'join'),
    member(CO_CREATOR, 'join'),
    member(MODERATOR, 'join'),
    member(MEMBER, 'join'),
    member(BANNED, 'ban'),
    member(LEFT, 'leave'),
  ]);
  return state;
}

/** The engine's crossing of js-sdk's `RoomMember.powerLevel`. */
function powerOf(state: RoomState, userId: string): PowerLevel {
  const level = state.getMember(userId)?.powerLevel ?? 0;
  return level === Infinity ? 'infinite' : level;
}

function message(sender: string): MatrixEvent {
  return new MatrixEvent({
    type: 'm.room.message',
    sender,
    room_id: ROOM,
    event_id: `$message-${++nextEvent}`,
    content: { msgtype: 'm.text', body: 'hi' },
  });
}

describe.each(FIXTURES)('room power parity with js-sdk: $name', (fixture) => {
  const state = roomStateFor(fixture);
  const { powerLevels } = fixture;

  it.each(USERS)('state sends for %s', (userId) => {
    const power = powerOf(state, userId);
    for (const type of STATE_TYPES) {
      expect([type, maySendState(powerLevels, power, type)]).toEqual([
        type,
        state.maySendStateEvent(type, userId),
      ]);
    }
  });

  it.each(USERS)('event sends for %s', (userId) => {
    const power = powerOf(state, userId);
    for (const type of EVENT_TYPES) {
      expect([type, maySendEvent(powerLevels, power, type)]).toEqual([
        type,
        state.maySendEvent(type, userId),
      ]);
    }
  });

  it.each(USERS)('invite, kick, ban and redact thresholds for %s', (userId) => {
    const power = powerOf(state, userId);
    const level = state.getMember(userId)?.powerLevel ?? 0;
    for (const action of ACTIONS) {
      expect([action, mayAct(powerLevels, power, action)]).toEqual([
        action,
        state.hasSufficientPowerLevelFor(action, level),
      ]);
    }
  });

  it.each(USERS)('redactions of own and others’ events for %s', (userId) => {
    const power = powerOf(state, userId);
    const membership = (state.getMember(userId)?.membership ??
      null) as Membership | null;
    for (const sender of [userId, MEMBER, CREATOR]) {
      expect([
        sender,
        mayRedactEvent(powerLevels, power, membership, sender === userId),
      ]).toEqual([
        sender,
        state.maySendRedactionForEvent(message(sender), userId),
      ]);
    }
  });
});

describe('room power', () => {
  it('gives v12 creators infinite power only once the room has power levels', () => {
    const state = roomStateFor(FIXTURES[3]);
    const bare = roomStateFor(FIXTURES[4]);

    expect(powerOf(state, CREATOR)).toBe('infinite');
    expect(powerOf(state, CO_CREATOR)).toBe('infinite');
    expect(powerOf(state, MODERATOR)).toBe(50);
    expect(powerOf(bare, CREATOR)).toBe(0);
  });

  it('lets infinite power pass every threshold', () => {
    const levels = { state_default: 1e9, kick: 1e9, events_default: 1e9 };

    expect(maySendState(levels, 'infinite', 'm.room.name')).toBe(true);
    expect(maySendEvent(levels, 'infinite', 'm.room.message')).toBe(true);
    expect(mayAct(levels, 'infinite', 'kick')).toBe(true);
  });

  it('maps infinite power back to Infinity for numeric comparisons', () => {
    expect(powerValue('infinite')).toBe(Infinity);
    expect(powerValue(50)).toBe(50);
  });
});
