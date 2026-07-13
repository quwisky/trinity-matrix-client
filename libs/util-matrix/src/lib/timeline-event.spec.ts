import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import {
  buildTimelineEventView,
  describeTimelineEvent,
  isDisplayableStateEvent,
} from './timeline-event';

interface EventInit {
  type: string;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
  stateKey?: string;
  sender?: string;
  state?: boolean;
  redacted?: boolean;
  id?: string;
  ts?: number;
}

function stateEvent(init: EventInit): MatrixEvent {
  return {
    getType: () => init.type,
    getContent: () => init.content ?? {},
    getPrevContent: () => init.prevContent ?? {},
    getStateKey: () => init.stateKey,
    getSender: () => init.sender ?? '@actor:hs',
    isState: () => init.state ?? true,
    isRedacted: () => init.redacted ?? false,
    getId: () => init.id ?? '$e',
    getTs: () => init.ts ?? 1000,
  } as unknown as MatrixEvent;
}

// Names come from the room; unknown ids fall back to the bare id.
const NAMES: Record<string, string> = {
  '@actor:hs': 'Mod',
  '@alice:hs': 'Alice',
  '@bob:hs': 'Bob',
};
const room = {
  getMember: (id: string) =>
    NAMES[id] ? ({ name: NAMES[id] } as never) : null,
} as unknown as Room;

/** Convenience: summary of a membership transition. */
function membership(
  membershipTo: string,
  extra: Partial<EventInit> = {},
): string | null {
  return describeTimelineEvent(
    stateEvent({
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: membershipTo, ...(extra.content ?? {}) },
      prevContent: extra.prevContent,
      sender: extra.sender ?? '@actor:hs',
    }),
    room,
  );
}

describe('isDisplayableStateEvent', () => {
  it('accepts supported, non-redacted state events', () => {
    expect(isDisplayableStateEvent(stateEvent({ type: 'm.room.name' }))).toBe(
      true,
    );
    expect(isDisplayableStateEvent(stateEvent({ type: 'm.room.member' }))).toBe(
      true,
    );
  });

  it('rejects redacted, non-state, and unsupported events', () => {
    expect(
      isDisplayableStateEvent(
        stateEvent({ type: 'm.room.name', redacted: true }),
      ),
    ).toBe(false);
    expect(
      isDisplayableStateEvent(
        stateEvent({ type: 'm.room.name', state: false }),
      ),
    ).toBe(false);
    expect(
      isDisplayableStateEvent(stateEvent({ type: 'm.room.message' })),
    ).toBe(false);
    expect(
      isDisplayableStateEvent(stateEvent({ type: 'm.room.power_levels' })),
    ).toBe(false);
  });
});

describe('describeTimelineEvent — membership', () => {
  it('joins, invites, knocks', () => {
    expect(membership('join')).toBe('Bob joined the room');
    expect(membership('invite')).toBe('Mod invited Bob');
    expect(membership('knock')).toBe('Bob requested to join');
  });

  it('leaving vs being removed vs unbanning', () => {
    expect(membership('leave', { sender: '@bob:hs' })).toBe(
      'Bob left the room',
    );
    expect(
      membership('leave', {
        sender: '@bob:hs',
        prevContent: { membership: 'invite' },
      }),
    ).toBe('Bob rejected the invitation');
    expect(membership('leave', { content: { reason: 'spam' } })).toBe(
      'Mod removed Bob: spam',
    );
    expect(membership('leave', { prevContent: { membership: 'invite' } })).toBe(
      "Mod withdrew Bob's invitation",
    );
    expect(membership('leave', { prevContent: { membership: 'ban' } })).toBe(
      'Mod unbanned Bob',
    );
  });

  it('bans with and without a reason', () => {
    expect(membership('ban', { content: { reason: 'abuse' } })).toBe(
      'Mod banned Bob: abuse',
    );
    expect(membership('ban')).toBe('Mod banned Bob');
  });

  it('display-name and avatar changes on an existing member', () => {
    expect(
      membership('join', {
        content: { displayname: 'Bobby' },
        prevContent: { membership: 'join', displayname: 'Bob' },
      }),
    ).toBe('Bob changed their display name to "Bobby"');
    expect(
      membership('join', {
        content: { avatar_url: 'mxc://hs/2' },
        prevContent: { membership: 'join', avatar_url: 'mxc://hs/1' },
      }),
    ).toBe('Bob changed their profile picture');
  });

  it('returns null for a no-op repeat join (nothing changed)', () => {
    expect(
      membership('join', {
        content: { displayname: 'Bob', avatar_url: 'mxc://x' },
        prevContent: {
          membership: 'join',
          displayname: 'Bob',
          avatar_url: 'mxc://x',
        },
      }),
    ).toBeNull();
  });
});

describe('describeTimelineEvent — room state', () => {
  it('name set / changed / removed', () => {
    expect(
      describeTimelineEvent(
        stateEvent({ type: 'm.room.name', content: { name: 'General' } }),
        room,
      ),
    ).toBe('Mod set the room name to "General"');
    expect(
      describeTimelineEvent(
        stateEvent({
          type: 'm.room.name',
          content: { name: 'Lobby' },
          prevContent: { name: 'General' },
        }),
        room,
      ),
    ).toBe('Mod changed the room name to "Lobby"');
    expect(
      describeTimelineEvent(
        stateEvent({ type: 'm.room.name', prevContent: { name: 'General' } }),
        room,
      ),
    ).toBe('Mod removed the room name');
  });

  it('topic, avatar, alias, join rules, history, guests, encryption, create', () => {
    const d = (type: string, content: Record<string, unknown> = {}) =>
      describeTimelineEvent(stateEvent({ type, content }), room);

    expect(d('m.room.topic', { topic: 'hi' })).toBe('Mod set the room topic');
    expect(d('m.room.avatar', { url: 'mxc://x' })).toBe(
      'Mod changed the room avatar',
    );
    expect(
      describeTimelineEvent(
        stateEvent({
          type: 'm.room.avatar',
          prevContent: { url: 'mxc://old' },
        }),
        room,
      ),
    ).toBe('Mod removed the room avatar');
    expect(d('m.room.canonical_alias', { alias: '#x:hs' })).toBe(
      'Mod set the main address to #x:hs',
    );
    expect(d('m.room.join_rules', { join_rule: 'public' })).toBe(
      'Mod made the room public (anyone can join)',
    );
    expect(d('m.room.join_rules', { join_rule: 'invite' })).toBe(
      'Mod made the room invite-only',
    );
    expect(
      d('m.room.history_visibility', { history_visibility: 'shared' }),
    ).toBe(
      'Mod made future room history visible to members, including history from before they joined',
    );
    expect(d('m.room.guest_access', { guest_access: 'forbidden' })).toBe(
      'Mod stopped guests from joining',
    );
    expect(d('m.room.encryption')).toBe('Mod turned on end-to-end encryption');
    expect(d('m.room.create')).toBe('Mod created the room');
  });

  it('falls back to the bare id when the actor is unknown', () => {
    expect(
      describeTimelineEvent(
        stateEvent({
          type: 'm.room.name',
          content: { name: 'X' },
          sender: '@ghost:hs',
        }),
        room,
      ),
    ).toBe('@ghost:hs set the room name to "X"');
  });

  it('returns null for an unsupported state type', () => {
    expect(
      describeTimelineEvent(stateEvent({ type: 'm.room.pinned_events' }), room),
    ).toBeNull();
  });

  it('drops a re-assert that did not change the value (no spurious "changed")', () => {
    const noop = (type: string, content: Record<string, unknown>) =>
      describeTimelineEvent(
        stateEvent({ type, content, prevContent: content }),
        room,
      );

    expect(noop('m.room.name', { name: 'General' })).toBeNull();
    expect(noop('m.room.topic', { topic: 'hi' })).toBeNull();
    expect(noop('m.room.join_rules', { join_rule: 'invite' })).toBeNull();
    expect(
      noop('m.room.history_visibility', { history_visibility: 'shared' }),
    ).toBeNull();
    expect(
      noop('m.room.guest_access', { guest_access: 'forbidden' }),
    ).toBeNull();
    expect(noop('m.room.avatar', { url: 'mxc://x' })).toBeNull();
    // A genuine change still renders.
    expect(
      describeTimelineEvent(
        stateEvent({
          type: 'm.room.name',
          content: { name: 'Lobby' },
          prevContent: { name: 'General' },
        }),
        room,
      ),
    ).toBe('Mod changed the room name to "Lobby"');
  });

  it('distinguishes changing from removing name/topic/alias', () => {
    const d = (
      type: string,
      content: Record<string, unknown>,
      prevContent: Record<string, unknown> = {},
    ) =>
      describeTimelineEvent(stateEvent({ type, content, prevContent }), room);

    expect(d('m.room.topic', { topic: 'new' }, { topic: 'old' })).toBe(
      'Mod changed the room topic',
    );
    expect(d('m.room.topic', {}, { topic: 'old' })).toBe(
      'Mod removed the room topic',
    );
    expect(d('m.room.canonical_alias', {}, { alias: '#x:hs' })).toBe(
      'Mod removed the main address',
    );
  });

  it('covers the remaining join-rule / history / guest / knock variants', () => {
    const d = (type: string, content: Record<string, unknown>) =>
      describeTimelineEvent(stateEvent({ type, content }), room);

    expect(d('m.room.join_rules', { join_rule: 'knock' })).toBe(
      'Mod allowed people to request to join',
    );
    expect(d('m.room.join_rules', { join_rule: 'restricted' })).toBe(
      'Mod changed who can join the room',
    );
    expect(
      d('m.room.history_visibility', { history_visibility: 'world_readable' }),
    ).toBe(
      'Mod made future room history visible to anyone, even without joining',
    );
    expect(
      d('m.room.history_visibility', { history_visibility: 'nonsense' }),
    ).toBe('Mod changed who can read history');
    expect(d('m.room.guest_access', { guest_access: 'can_join' })).toBe(
      'Mod allowed guests to join',
    );
    expect(
      describeTimelineEvent(
        stateEvent({
          type: 'm.room.member',
          stateKey: '@bob:hs',
          sender: '@bob:hs',
          content: { membership: 'leave' },
          prevContent: { membership: 'knock' },
        }),
        room,
      ),
    ).toBe('Bob cancelled their request to join');
  });
});

describe('buildTimelineEventView', () => {
  it('projects an event into a kind:"event" view carrying the summary', () => {
    const client = { getUserId: () => '@me:hs' } as unknown as MatrixClient;
    const event = stateEvent({
      type: 'm.room.name',
      content: { name: 'General' },
      sender: '@actor:hs',
      id: '$name',
      ts: 4242,
    });
    const view = buildTimelineEventView(client, room, event, 'Mod set it');

    expect(view.kind).toBe('event');
    expect(view.summary).toBe('Mod set it');
    expect(view.body).toBe('Mod set it');
    expect(view.id).toBe('$name');
    expect(view.timestamp).toBe(4242);
    expect(view.senderName).toBe('Mod');
    expect(view.isOwn).toBe(false);
    expect(view.reactions).toEqual([]);
    expect(view.readReceipts).toEqual([]);
  });
});
