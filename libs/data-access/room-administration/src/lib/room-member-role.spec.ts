import { describe, expect, it } from 'vitest';
import { type MemberSummary } from './room-members.service';
import {
  ASSIGNABLE_MEMBER_ROLES,
  MEMBER_ROLE_LABEL,
  MEMBER_ROLE_ORDER,
  memberRole,
} from './room-member-role';

function member(powerLevel: number, isCreator = false): MemberSummary {
  return {
    userId: '@a:hs',
    roomDisplayName: 'Ada',
    roomInitial: 'A',
    roomAvatarMxc: null,
    powerLevel,
    isCreator,
  };
}

describe('memberRole', () => {
  it('distinguishes the creator from an admin at the same power', () => {
    expect(memberRole(member(100, true))).toBe('owner');
    expect(memberRole(member(100))).toBe('admin');
  });

  it('classifies arbitrary power values by the highest cleared threshold', () => {
    expect(memberRole(member(101))).toBe('admin');
    expect(memberRole(member(99))).toBe('moderator');
    expect(memberRole(member(50))).toBe('moderator');
    expect(memberRole(member(49))).toBe('member');
  });

  it('reports a demoted creator by current authority', () => {
    expect(memberRole(member(99, true))).toBe('moderator');
    expect(memberRole(member(0, true))).toBe('member');
  });

  it('suppresses owner hierarchy in a direct message', () => {
    expect(memberRole(member(100, true), { direct: true })).toBe('admin');
  });
});

describe('Room Administration role catalog', () => {
  it('orders and labels every display role', () => {
    expect(MEMBER_ROLE_ORDER).toEqual([
      'owner',
      'admin',
      'moderator',
      'member',
    ]);
    expect([...MEMBER_ROLE_ORDER].sort()).toEqual(
      Object.keys(MEMBER_ROLE_LABEL).sort(),
    );
  });

  it('offers only roles that a power-level write can assign', () => {
    expect(ASSIGNABLE_MEMBER_ROLES).toEqual([
      { role: 'member', label: 'Member', level: 0 },
      { role: 'moderator', label: 'Moderator', level: 50 },
      { role: 'admin', label: 'Admin', level: 100 },
    ]);
  });
});
