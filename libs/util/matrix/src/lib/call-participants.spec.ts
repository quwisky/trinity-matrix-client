import { callParticipants, type CallMemberEvent } from './call-participants';

describe('callParticipants', () => {
  const member = (
    content: Record<string, unknown>,
    ts = 1000,
  ): CallMemberEvent => ({
    type: 'org.matrix.msc3401.call.member',
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
