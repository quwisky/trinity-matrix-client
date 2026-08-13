import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import { RoomsService, type MemberSummary } from '@trinity/data-access/rooms';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { SpaceMembersComponent } from './space-members.component';

function member(
  userId: string,
  name: string,
  powerLevel = 0,
  isCreator = false,
): MemberSummary {
  return {
    userId,
    name,
    initial: name[0],
    avatarMxc: null,
    powerLevel,
    isCreator,
  };
}

async function build(members: MemberSummary[] = []) {
  const close = vi.fn();
  // A signal per room id, as the real service hands out — so the room asked for is still
  // assertable, and a test can move the membership under the component.
  const roster = signal(members);
  // Respects the room id, so a component watching the wrong room fails rather than
  // getting the fixture anyway.
  const membersFor = vi.fn((roomId: string | null) =>
    roomId === '!s:hs' ? roster.asReadonly() : signal([]).asReadonly(),
  );
  const { fixture, container } = await render(SpaceMembersComponent, {
    inputs: { spaceId: '!s:hs', spaceName: 'Design' },
    providers: [
      MockProvider(RoomsService, { membersFor }),
      MockProvider(TrnDialogRef, { close }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    close,
    membersFor,
    roster,
  };
}

describe('SpaceMembersComponent', () => {
  it('lists the space’s members', async () => {
    // A space IS a room, so the member projection answers for a space id unchanged — the
    // gap was never the data, only that nothing asked.
    const { cmp, membersFor } = await build([
      member('@a:hs', 'Ada'),
      member('@b:hs', 'Bo'),
    ]);

    expect(membersFor).toHaveBeenCalledWith('!s:hs');
    expect(cmp.members().map((m) => m.userId)).toEqual(['@a:hs', '@b:hs']);
  });

  it('names the roles the moderation UI acts on', async () => {
    // The raw power level means nothing to anyone who has not read the spec.
    const { cmp } = await build();

    expect(cmp.roleOf(member('@a:hs', 'Ada', 100))).toBe('Admin');
    expect(cmp.roleOf(member('@b:hs', 'Bo', 50))).toBe('Moderator');
    expect(cmp.roleOf(member('@c:hs', 'Cy', 0))).toBe('');
  });

  it('treats an unusual power level by the level it clears', async () => {
    // Power levels are arbitrary integers, not an enum — 75 is a moderator, 101 an admin.
    const { cmp } = await build();

    expect(cmp.roleOf(member('@a:hs', 'Ada', 75))).toBe('Moderator');
    expect(cmp.roleOf(member('@b:hs', 'Bo', 101))).toBe('Admin');
    expect(cmp.roleOf(member('@c:hs', 'Cy', 49))).toBe('');
  });

  it('names the space creator the owner', async () => {
    // A space IS a room, so it has a creator too — the same distinction applies, and the
    // space's founder is separated from anyone they promoted to the same power.
    const { cmp } = await build();

    expect(cmp.roleOf(member('@f:hs', 'Founder', 100, true))).toBe('Owner');
    expect(cmp.roleOf(member('@p:hs', 'Promoted', 100))).toBe('Admin');
  });

  it('names a demoted space creator by the power they now hold', async () => {
    const { cmp } = await build();

    expect(cmp.roleOf(member('@f:hs', 'Founder', 0, true))).toBe('');
  });

  it('resolves the picked member so the host can open member info', async () => {
    // Resolved rather than emitted: TrnDialogService maps `inputs` only, so an output
    // would silently never be wired.
    const picked = member('@a:hs', 'Ada');
    const { cmp, close } = await build([picked]);

    cmp.pick(picked);

    expect(close).toHaveBeenCalledWith(picked);
  });

  it('resolves nothing when dismissed', async () => {
    const { cmp, close } = await build([member('@a:hs', 'Ada')]);

    cmp.close();

    expect(close).toHaveBeenCalledWith(null);
  });

  it('renders a row per member, addressable by user id', async () => {
    const { container } = await build([
      member('@a:hs', 'Ada'),
      member('@b:hs', 'Bo'),
    ]);

    expect(
      container.querySelectorAll('[data-testid^="space-member-"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="space-member-@a:hs"]'),
    ).not.toBeNull();
  });

  it('says so when the space has no other members', async () => {
    const { container } = await build([]);

    expect(container.textContent).toContain('Nobody else is in this space yet');
  });

  it('follows the projection when someone joins the space', async () => {
    // The list is a projection now, not a snapshot read — the harness hands out a signal
    // for exactly that, and nothing exercised it.
    const { cmp, roster } = await build([member('@a:hs', 'Ada')]);

    roster.set([member('@a:hs', 'Ada'), member('@b:hs', 'Bo')]);

    expect(cmp.members().map((m) => m.userId)).toEqual(['@a:hs', '@b:hs']);
  });
});
