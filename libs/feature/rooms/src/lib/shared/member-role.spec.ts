import { type MemberSummary } from '@trinity/data-access/room-library';
import { describe, expect, it } from 'vitest';
import {
  MEMBER_ROLE_LABEL,
  MEMBER_ROLE_ORDER,
  memberRole,
} from './member-role';

function member(powerLevel: number, isCreator = false): MemberSummary {
  return {
    userId: '@a:hs',
    name: 'Ada',
    initial: 'A',
    avatarMxc: null,
    powerLevel,
    isCreator,
  };
}

describe('memberRole', () => {
  it('names the creator the owner', () => {
    expect(memberRole(member(100, true))).toBe('owner');
  });

  it('separates the creator from everyone else at the same power', () => {
    // The whole point: an admin the creator promoted also sits at 100, and a power level
    // alone cannot tell them apart.
    expect(memberRole(member(100, true))).toBe('owner');
    expect(memberRole(member(100, false))).toBe('admin');
  });

  it('applies the standard convention below admin', () => {
    expect(memberRole(member(50))).toBe('moderator');
    expect(memberRole(member(0))).toBe('member');
  });

  it('classifies by the threshold cleared, not by an exact value', () => {
    // Power levels are arbitrary integers, not an enum.
    expect(memberRole(member(101))).toBe('admin');
    expect(memberRole(member(99))).toBe('moderator');
    expect(memberRole(member(75))).toBe('moderator');
    expect(memberRole(member(49))).toBe('member');
  });

  it('reports a demoted creator by the power they now hold', () => {
    // The list is a ranking. A founder who dropped themselves to 0 rendered above the
    // admins who actually run the room would misrepresent it — so Owner requires the
    // creator to still hold admin-level power.
    expect(memberRole(member(0, true))).toBe('member');
    expect(memberRole(member(50, true))).toBe('moderator');
    expect(memberRole(member(99, true))).toBe('moderator');
  });

  it('does not rank a non-creator above the owner on power alone', () => {
    // Documented limitation rather than an accident: someone deliberately placed at 150
    // reads as Admin and so sorts BELOW a creator at 100. Treating the ladder above 100
    // as continuous is a separate concern from "whose room is this".
    expect(memberRole(member(150, false))).toBe('admin');
    expect(memberRole(member(100, true))).toBe('owner');
  });
});

describe('memberRole in a direct message', () => {
  it('gives a DM no owner, because nobody owns a 1:1 chat', () => {
    // createDirectMessage uses the trusted_private_chat preset, which puts BOTH people
    // at 100. Ranking one above the other asserts a hierarchy that does not exist.
    expect(memberRole(member(100, true), { direct: true })).toBe('admin');
    expect(memberRole(member(100, false), { direct: true })).toBe('admin');
  });

  it('leaves the lower tiers alone in a direct message', () => {
    expect(memberRole(member(50), { direct: true })).toBe('moderator');
    expect(memberRole(member(0), { direct: true })).toBe('member');
  });

  it('still names an owner in a normal room', () => {
    expect(memberRole(member(100, true), { direct: false })).toBe('owner');
    expect(memberRole(member(100, true))).toBe('owner');
  });
});

describe('MEMBER_ROLE_ORDER', () => {
  it('ranks owner highest and covers every role', () => {
    expect(MEMBER_ROLE_ORDER[0]).toBe('owner');
    expect([...MEMBER_ROLE_ORDER].sort()).toEqual(
      Object.keys(MEMBER_ROLE_LABEL).sort(),
    );
  });
});

describe('MEMBER_ROLE_LABEL', () => {
  it('labels every role', () => {
    for (const role of MEMBER_ROLE_ORDER) {
      expect(MEMBER_ROLE_LABEL[role]).toBeTruthy();
    }
  });
});
