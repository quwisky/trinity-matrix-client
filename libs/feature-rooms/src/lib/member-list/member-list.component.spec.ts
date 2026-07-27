import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { AvatarComponent } from '@trinity/ui';
import { PresenceService } from '@trinity/data-access-profile';
import { type PresenceState } from '@trinity/util-matrix';
import { MockComponent } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { MemberListComponent } from './member-list.component';

// Stub presence per user id (defaults to offline).
const presenceMap: Record<string, PresenceState> = {
  '@z:hs': 'online',
  '@a:hs': 'offline',
};
const presenceStub = {
  presenceFor: (userId: string) =>
    signal<PresenceState>(presenceMap[userId] ?? 'offline'),
};
const providers = [{ provide: PresenceService, useValue: presenceStub }];

// A member view-model, defaulting to a regular member (power level 0).
function member(over: Partial<MemberSummaryLike> & { userId: string }) {
  return {
    name: over.userId,
    initial: over.userId[1]?.toUpperCase() ?? '?',
    avatarMxc: null,
    powerLevel: 0,
    isCreator: false,
    ...over,
  };
}
type MemberSummaryLike = ReturnType<typeof member>;

const opts = { imports: [MockComponent(AvatarComponent)], providers };

/** Visible section headers, in render order (e.g. ['Admin — 1', 'Member — 2']). */
function sectionLabels(container: HTMLElement): (string | undefined)[] {
  return [...container.querySelectorAll('.members__section-label')].map((n) =>
    n.textContent?.trim(),
  );
}

/** Each section's visible label mapped to the member names rendered under it. */
function sectionMap(container: HTMLElement): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const section of container.querySelectorAll('.members__section')) {
    const label =
      section.querySelector('.members__section-label')?.textContent?.trim() ??
      '';
    map[label] = [...section.querySelectorAll('.member__name')].map(
      (n) => n.textContent?.trim() ?? '',
    );
  }
  return map;
}

// Input arrives name-sorted (Anna, Zoe) — but Anna is offline and Zoe is online.
// Both are regular members (power level 0), so they share one "Member" section.
const MEMBERS = [
  member({ userId: '@a:hs', name: 'Anna' }),
  member({ userId: '@z:hs', name: 'Zoe' }),
];

describe('MemberListComponent', () => {
  it('emits selectMember with the clicked member', async () => {
    const clicked = member({ userId: '@z:hs' });
    const { fixture, container } = await render(MemberListComponent, {
      inputs: { members: [clicked, member({ userId: '@a:hs' })] },
      ...opts,
    });
    let selected: { userId: string } | undefined;
    fixture.componentInstance.selectMember.subscribe((m) => (selected = m));

    container
      .querySelectorAll<HTMLElement>('[data-testid="member-row"]')[0]
      .click();

    expect(selected?.userId).toBe('@z:hs');
  });

  it('orders online members above offline ones, keeping names within a group', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: MEMBERS },
      ...opts,
    });

    const names = [...container.querySelectorAll('.member__name')].map((n) =>
      n.textContent?.trim(),
    );
    // Zoe (online) rises above Anna (offline) despite Anna sorting first by name.
    expect(names).toEqual(['Zoe', 'Anna']);
  });

  it('dims offline members', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: MEMBERS },
      ...opts,
    });

    const rows = container.querySelectorAll('.member');
    expect(rows.length).toBe(2);
    // The offline member (Anna, second row after sorting) carries the dim class.
    const offline = container.querySelector('.member--offline');
    expect(offline?.textContent).toContain('Anna');
  });

  it('regroups a name-sorted, role-interleaved list under the right headers', async () => {
    // Realistic input: membersOf returns members name-sorted, so roles interleave —
    // Bo (moderator) sits alphabetically between the two regular members.
    const members = [
      member({ userId: '@ada:hs', name: 'Ada', powerLevel: 100 }),
      member({ userId: '@alice:hs', name: 'Alice', powerLevel: 0 }),
      member({ userId: '@bo:hs', name: 'Bo', powerLevel: 50 }),
      member({ userId: '@cy:hs', name: 'Cy', powerLevel: 0 }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    // Sections appear highest-role first, and each header holds exactly its members —
    // proving the partition regroups rather than relying on input order.
    expect(sectionLabels(container)).toEqual([
      'Admin — 1',
      'Moderator — 1',
      'Member — 2',
    ]);
    expect(sectionMap(container)).toEqual({
      'Admin — 1': ['Ada'],
      'Moderator — 1': ['Bo'],
      'Member — 2': ['Alice', 'Cy'],
    });
  });

  it('gives the room creator their own section above the admins', async () => {
    // The gap this section exists for: both of these sit at 100, and before the creator
    // flag there was no way to tell whose room it is.
    const members = [
      member({
        userId: '@founder:hs',
        name: 'Founder',
        powerLevel: 100,
        isCreator: true,
      }),
      member({ userId: '@promoted:hs', name: 'Promoted', powerLevel: 100 }),
      member({ userId: '@reg:hs', name: 'Reg', powerLevel: 0 }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    expect(sectionLabels(container)).toEqual([
      'Owner — 1',
      'Admin — 1',
      'Member — 1',
    ]);
    expect(sectionMap(container)).toEqual({
      'Owner — 1': ['Founder'],
      'Admin — 1': ['Promoted'],
      'Member — 1': ['Reg'],
    });
  });

  it('shows no Owner section in a direct message', async () => {
    // A DM is created with the trusted_private_chat preset, which puts BOTH people at
    // 100 — so without the `direct` flag whoever started the chat is hoisted above their
    // friend, asserting a hierarchy that does not exist in a 1:1 conversation.
    const members = [
      member({
        userId: '@me:hs',
        name: 'Me',
        powerLevel: 100,
        isCreator: true,
      }),
      member({ userId: '@them:hs', name: 'Them', powerLevel: 100 }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members, direct: true },
      ...opts,
    });

    expect(sectionLabels(container)).toEqual(['Admin — 2']);
    expect(sectionMap(container)['Admin — 2']).toEqual(['Me', 'Them']);
  });

  it('shows no Owner section when the creator has left the room', async () => {
    // getJoinedMembers() drops them, so nothing carries the flag — the list must not
    // render an empty section for an absent founder.
    const members = [member({ userId: '@a:hs', name: 'Ada', powerLevel: 100 })];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    expect(sectionLabels(container)).toEqual(['Admin — 1']);
  });

  it('lists a demoted creator by the power they now hold', async () => {
    // The sections are a ranking. A founder who dropped themselves to 0 rendered above
    // the admins who actually run the room would misrepresent it.
    const members = [
      member({ userId: '@admin:hs', name: 'Admin', powerLevel: 100 }),
      member({
        userId: '@founder:hs',
        name: 'Founder',
        powerLevel: 0,
        isCreator: true,
      }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    expect(sectionLabels(container)).toEqual(['Admin — 1', 'Member — 1']);
    expect(sectionMap(container)['Member — 1']).toEqual(['Founder']);
  });

  it('keeps online-first ordering within a role section', async () => {
    // Two moderators: online sorts above offline inside the Moderator section.
    const members = [
      member({ userId: '@a:hs', name: 'Anna', powerLevel: 50 }),
      member({ userId: '@z:hs', name: 'Zoe', powerLevel: 50 }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    expect(sectionMap(container)).toEqual({ 'Moderator — 2': ['Zoe', 'Anna'] });
  });

  it('omits role sections that have no members', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: [member({ userId: '@cy:hs', name: 'Cy' })] },
      ...opts,
    });

    expect(sectionLabels(container)).toEqual(['Member — 1']);
  });

  it.each([
    [49, 'Member — 1'],
    [50, 'Moderator — 1'],
    [99, 'Moderator — 1'],
    [100, 'Admin — 1'],
    [150, 'Admin — 1'],
  ])(
    'classifies power level %i at the role threshold',
    async (powerLevel, label) => {
      const { container } = await render(MemberListComponent, {
        inputs: {
          members: [member({ userId: '@a:hs', name: 'Anna', powerLevel })],
        },
        ...opts,
      });

      expect(sectionLabels(container)).toEqual([label]);
    },
  );

  it('re-partitions live when a member is promoted then demoted', async () => {
    const at = (powerLevel: number) => [
      member({ userId: '@a:hs', name: 'Anna', powerLevel }),
    ];
    const { container, fixture } = await render(MemberListComponent, {
      inputs: { members: at(0) },
      ...opts,
    });
    expect(sectionLabels(container)).toEqual(['Member — 1']);

    fixture.componentRef.setInput('members', at(100)); // promote to admin
    fixture.detectChanges();
    expect(sectionLabels(container)).toEqual(['Admin — 1']);

    fixture.componentRef.setInput('members', at(0)); // demote back
    fixture.detectChanges();
    expect(sectionLabels(container)).toEqual(['Member — 1']);
  });

  it('exposes each role section as a named group for assistive tech', async () => {
    const members = [
      member({ userId: '@ada:hs', name: 'Ada', powerLevel: 100 }),
      member({ userId: '@cy:hs', name: 'Cy', powerLevel: 0 }),
      member({ userId: '@di:hs', name: 'Di', powerLevel: 0 }),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    const groups = [...container.querySelectorAll('[role="group"]')].map((g) =>
      g.getAttribute('aria-label'),
    );
    // Count is pluralised, and the visual label is hidden from AT to avoid a double read.
    expect(groups).toEqual(['Admin, 1 member', 'Member, 2 members']);
    expect(
      container
        .querySelector('.members__section-label')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('renders a role icon in every section header', async () => {
    const members = [
      member({ userId: '@ada:hs', name: 'Ada', powerLevel: 100 }),
      member({ userId: '@bo:hs', name: 'Bo', powerLevel: 50 }),
      member({ userId: '@cy:hs', name: 'Cy', powerLevel: 0 }),
    ];
    const { container, fixture } = await render(MemberListComponent, {
      inputs: { members },
      ...opts,
    });

    // Each of the three section headers renders exactly one icon that resolves to
    // a real SVG (i.e. the lucide icon name is registered, not just the host element).
    const sections = container.querySelectorAll('.members__section');
    expect(sections.length).toBe(3);
    for (const section of sections) {
      const icons = section.querySelectorAll('.members__section-icon');
      expect(icons.length).toBe(1);
      expect(icons[0].querySelector('svg')).not.toBeNull();
    }

    // Crown for admins, shield for moderators, user for members — highest role first.
    expect(fixture.componentInstance.sections().map((s) => s.icon)).toEqual([
      'lucideCrown',
      'lucideShield',
      'lucideUser',
    ]);
  });
});
