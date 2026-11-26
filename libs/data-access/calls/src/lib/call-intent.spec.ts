import {
  callIntent,
  callParticipants,
  callWidgetUrl,
  formatCallElapsed,
  hasOngoingCall,
  type ElementCallIntent,
} from './call-intent';
import type { RawCallEvent } from './call-transport';

describe('callIntent', () => {
  it.each<[boolean, boolean, boolean, ElementCallIntent]>([
    [false, false, true, 'start_call'],
    [false, false, false, 'start_call_voice'],
    [false, true, true, 'join_existing'],
    [false, true, false, 'join_existing_voice'],
    [true, false, true, 'start_call_dm'],
    [true, false, false, 'start_call_dm_voice'],
    [true, true, true, 'join_existing_dm'],
    [true, true, false, 'join_existing_dm_voice'],
  ])('dm=%s ongoing=%s video=%s -> %s', (dm, ongoing, video, expected) => {
    expect(callIntent({ dm, ongoing, video })).toBe(expected);
  });
});

describe('hasOngoingCall', () => {
  const member = (
    content: Record<string, unknown>,
    ts = 1000,
  ): RawCallEvent => ({
    type: 'org.matrix.msc3401.call.member',
    event_id: '$e',
    room_id: '!r:x',
    sender: '@a:x',
    origin_server_ts: ts,
    content,
  });

  it('is false without events', () => {
    expect(hasOngoingCall([], 5000)).toBe(false);
  });

  it('is false when every member left', () => {
    expect(hasOngoingCall([member({}), member({})], 5000)).toBe(false);
  });

  it('is true for a member without expiry', () => {
    expect(hasOngoingCall([member({ application: 'm.call' })], 5000)).toBe(
      true,
    );
  });

  it('is false once expires_ts has passed', () => {
    expect(hasOngoingCall([member({ expires_ts: 4000 })], 5000)).toBe(false);
    expect(hasOngoingCall([member({ expires_ts: 6000 })], 5000)).toBe(true);
  });

  it('is false once origin_server_ts + expires has passed', () => {
    expect(hasOngoingCall([member({ expires: 3000 }, 1000)], 5000)).toBe(false);
    expect(hasOngoingCall([member({ expires: 5000 }, 1000)], 5000)).toBe(true);
  });

  it('treats malformed content as not ongoing', () => {
    const bad = { ...member({}), content: null } as unknown as RawCallEvent;
    expect(hasOngoingCall([bad], 5000)).toBe(false);
  });

  it('ignores non-numeric expiry fields', () => {
    expect(
      hasOngoingCall([member({ expires_ts: '1', expires: 'x' })], 5000),
    ).toBe(true);
  });

  it('reads the legacy memberships array', () => {
    expect(hasOngoingCall([member({ memberships: [] })], 5000)).toBe(false);
    expect(hasOngoingCall([member({ memberships: [{ a: 1 }] })], 5000)).toBe(
      true,
    );
  });

  it('keeps a member whose expiry equals now', () => {
    expect(hasOngoingCall([member({ expires_ts: 5000 })], 5000)).toBe(true);
  });

  it('ignores other event types', () => {
    expect(
      hasOngoingCall([{ ...member({ a: 1 }), type: 'm.room.member' }], 5000),
    ).toBe(false);
  });
});

describe('callParticipants', () => {
  const member = (
    content: Record<string, unknown>,
    ts = 1000,
  ): RawCallEvent => ({
    type: 'org.matrix.msc3401.call.member',
    event_id: '$e',
    room_id: '!r:x',
    sender: '@a:x',
    origin_server_ts: ts,
    content,
  });

  it('counts live members and reports the earliest expiry', () => {
    expect(
      callParticipants(
        [member({ expires_ts: 9000 }), member({ expires_ts: 7000 })],
        5000,
      ),
    ).toEqual({ count: 2, nextExpiryMs: 7000 });
  });

  it('skips left and expired members, and their expiry', () => {
    expect(
      callParticipants(
        [
          member({}),
          member({ expires_ts: 4000 }),
          member({ expires_ts: 8000 }),
        ],
        5000,
      ),
    ).toEqual({ count: 1, nextExpiryMs: 8000 });
  });

  it('resolves a relative expires from origin_server_ts', () => {
    expect(callParticipants([member({ expires: 5000 }, 1000)], 5000)).toEqual({
      count: 1,
      nextExpiryMs: 6000,
    });
  });

  it('counts every entry of a legacy memberships array without expiry', () => {
    expect(callParticipants([member({ memberships: [{}, {}] })], 5000)).toEqual(
      { count: 2, nextExpiryMs: null },
    );
    expect(callParticipants([member({ memberships: [] })], 5000).count).toBe(0);
  });

  it('counts a member without expiry fields', () => {
    expect(callParticipants([member({ application: 'm.call' })], 5000)).toEqual(
      { count: 1, nextExpiryMs: null },
    );
  });

  it('ignores other event types', () => {
    expect(
      callParticipants([{ ...member({ a: 1 }), type: 'm.room.member' }], 5000),
    ).toEqual({ count: 0, nextExpiryMs: null });
  });
});

describe('callWidgetUrl', () => {
  const base = {
    widgetId: 'w1',
    roomId: '!r:x',
    userId: '@a:x',
    deviceId: 'DEV',
    homeserverUrl: 'https://hs.example',
    intent: 'start_call' as const,
    theme: 'dark' as const,
  };

  it('builds the embedded Element Call URL', () => {
    const url = new URL(
      callWidgetUrl({ ...base, appOrigin: 'https://app.example' }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://app.example/element-call/index.html',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      widgetId: 'w1',
      parentUrl: 'https://app.example',
      baseUrl: 'https://hs.example',
      roomId: '!r:x',
      userId: '@a:x',
      deviceId: 'DEV',
      intent: 'start_call',
      theme: 'dark',
      confineToRoom: 'true',
      lang: 'en',
      enableE2EE: 'true',
    });
    expect(url.searchParams.has('skipLobby')).toBe(false);
    expect(url.searchParams.has('header')).toBe(false);
  });

  it('keeps the Electron app origin', () => {
    const url = new URL(callWidgetUrl({ ...base, appOrigin: 'trinity://app' }));
    expect(url.protocol).toBe('trinity:');
    expect(url.host).toBe('app');
    expect(url.searchParams.get('parentUrl')).toBe('trinity://app');
  });
});

describe('formatCallElapsed', () => {
  it.each([
    [252_000, '4:12'],
    [5_000, '0:05'],
    [3_723_000, '1:02:03'],
    [-1, '0:00'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatCallElapsed(ms)).toBe(text);
  });
});
