import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { AvatarComponent } from '@trinity/components/avatar';
import { PresenceService } from '@trinity/data-access/profile';
import { type MemberSummary } from '@trinity/data-access/rooms';
import { type PresenceState } from '@trinity/util/matrix';
import { MockComponent } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemberListComponent } from './member-list.component';
import { provideTrnIcons } from '@trinity/components/icon';

// Stub presence per user id (defaults to offline).
const presenceMap: Record<string, PresenceState> = {
  '@z:hs': 'online',
  '@a:hs': 'offline',
};
const presenceStub = {
  presenceFor: (userId: string) =>
    signal<PresenceState>(presenceMap[userId] ?? 'offline'),
};
const providers = [
  { provide: PresenceService, useValue: presenceStub },
  // Icons register once at the app root now (provideTrnIcons in main.ts) instead of per
  // component, so a spec asserting a real <svg> renders has to mirror that root here.
  provideTrnIcons(),
];

// A member view-model, defaulting to a regular member (power level 0).
function member(
  over: Partial<MemberSummary> & { userId: string },
): MemberSummary {
  return {
    name: over.userId,
    initial: over.userId[1]?.toUpperCase() ?? '?',
    avatarMxc: null,
    powerLevel: 0,
    isCreator: false,
    ...over,
  };
}
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
  it('marks its labelled filter as the panel focus target', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: MEMBERS },
      ...opts,
    });

    const targets = container.querySelectorAll('[data-right-panel-focus]');
    expect(targets).toHaveLength(1);
    expect(targets[0].tagName).toBe('INPUT');
    expect(targets[0].closest('label')?.textContent).toContain(
      'Filter members',
    );
  });

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
    // a real SVG (i.e. the icon name is registered, not just the host element).
    const sections = container.querySelectorAll('.members__section');
    expect(sections.length).toBe(3);
    for (const section of sections) {
      const icons = section.querySelectorAll('.members__section-icon');
      expect(icons.length).toBe(1);
      expect(icons[0].querySelector('svg')).not.toBeNull();
    }

    // Crown for admins, shield for moderators, user for members — highest role first.
    expect(fixture.componentInstance.sections().map((s) => s.icon)).toEqual([
      'crown',
      'shield',
      'user',
    ]);
  });
});

describe('MemberListComponent — filtering', () => {
  const people = [
    member({ userId: '@amelia:hs', name: 'Amelia' }),
    member({ userId: '@bo:hs', name: 'Bo' }),
    member({ userId: '@carla:hs', name: 'Carla' }),
  ];

  /** Type into the filter and let the signal settle. */
  async function filterBy(container: HTMLElement, text: string) {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=member-filter]',
    )!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    TestBed.tick();
  }

  function names(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.member__name')].map(
      (n) => n.textContent?.trim() ?? '',
    );
  }

  it('narrows the list to a name match', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: people },
      ...opts,
    });

    await filterBy(container, 'car');

    expect(names(container)).toEqual(['Carla']);
  });

  it('matches the user id too, which is how you tell two Bos apart', async () => {
    // The two questions a filter answers are different: a reader scanning for someone
    // they can see types the display name, one disambiguating types the id. A
    // name-only filter would return both Bos and answer neither.
    const { container } = await render(MemberListComponent, {
      inputs: {
        members: [
          member({ userId: '@bo:hs', name: 'Bo' }),
          member({ userId: '@robert:hs', name: 'Bo' }),
        ],
      },
      ...opts,
    });

    await filterBy(container, 'robert');

    expect(container.querySelectorAll('.member').length).toBe(1);
    expect(container.querySelector('.member')?.getAttribute('title')).toBe(
      '@robert:hs',
    );
  });

  it('is case-insensitive on both sides', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: [member({ userId: '@a:hs', name: 'AMELIA' })] },
      ...opts,
    });

    await filterBy(container, 'amelia');

    expect(names(container)).toEqual(['AMELIA']);
  });

  it('says so when nothing matches, rather than showing an empty panel', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: people },
      ...opts,
    });

    await filterBy(container, 'nobody here');

    expect(names(container)).toEqual([]);
    expect(
      container.querySelector('[data-testid=member-filter-empty]'),
    ).not.toBeNull();
  });

  it('announces the match count, which windowing makes unreadable otherwise', async () => {
    // The rows outside the scroll window are not in the DOM, so a screen reader cannot
    // count what survived a filter by walking the list. The region is rendered from the
    // start and only its text changes — one created at the moment it has something to say
    // is one the screen reader was not yet watching.
    const { container } = await render(MemberListComponent, {
      inputs: { members: people },
      ...opts,
    });
    const status = container.querySelector(
      '[data-testid=member-filter-status]',
    )!;
    expect(status.textContent?.trim()).toBe('');

    await filterBy(container, 'a');

    expect(status.textContent?.trim()).toBe('2 members match');

    await filterBy(container, 'carla');

    expect(status.textContent?.trim()).toBe('1 member matches');
  });

  it('shows no empty-state message when the room itself is empty', async () => {
    // An unfiltered empty list is the room's business, not the filter's — claiming
    // "no members match that" when nothing was typed would be a lie.
    const { container } = await render(MemberListComponent, {
      inputs: { members: [] },
      ...opts,
    });

    expect(
      container.querySelector('[data-testid=member-filter-empty]'),
    ).toBeNull();
  });
});

describe('MemberListComponent — windowing', () => {
  // The component's own geometry, restated so a change to either has to be made twice —
  // deliberately, because these numbers are the contract between the spacer arithmetic and
  // the stylesheet. That they match the RENDERED height is not checkable here (jsdom does
  // no layout); `member-info.spec.mts` measures both in Chromium.
  const HEADER_PX = 34;
  const ROW_PX = 44;

  /** Past SMALL_LIST_ROWS (80), so `computeWindow`'s render-everything path is off. */
  function crowd(n: number): MemberSummary[] {
    return Array.from({ length: n }, (_, i) =>
      member({
        userId: `@u${String(i).padStart(4, '0')}:hs`,
        name: `User ${i}`,
      }),
    );
  }

  /** The ResizeObserver watching the scroll host, from the test-setup stub. */
  interface TestRO {
    observed: Set<Element>;
    emit(entries: ResizeObserverEntry[]): void;
  }
  function hostObserver(): TestRO {
    const ro = (
      ResizeObserver as unknown as { instances: TestRO[] }
    ).instances.find((o) =>
      [...o.observed].some((el) => el.matches?.('aside')),
    );
    if (!ro) {
      throw new Error('scroll-host ResizeObserver not found');
    }
    return ro;
  }

  /** Give the panel a real viewport height, which jsdom otherwise reports as 0. */
  function setViewport(container: HTMLElement, height: number) {
    const host = container.querySelector('aside')!;
    hostObserver().emit([
      {
        target: host,
        contentRect: { height } as DOMRectReadOnly,
      } as unknown as ResizeObserverEntry,
    ]);
    TestBed.tick();
  }

  function rowCount(container: HTMLElement): number {
    return container.querySelectorAll('[data-testid=member-row]').length;
  }

  /** The two spacer divs, in order. */
  function spacers(container: HTMLElement): number[] {
    return [...container.querySelectorAll('aside > div[aria-hidden=true]')].map(
      (el) => Number.parseFloat((el as HTMLElement).style.height) || 0,
    );
  }

  beforeEach(() => {
    (ResizeObserver as unknown as { instances: unknown[] }).instances.length =
      0;
  });

  it('renders a short list whole, without paying for windowing', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(20) },
      ...opts,
    });
    setViewport(container, 400);

    expect(rowCount(container)).toBe(20);
    expect(spacers(container)).toEqual([0, 0]);
  });

  it("keeps the spacers out of the flex column's shrinking", async () => {
    // `.members` is a flex COLUMN, so a spacer with only an inline height has
    // `flex-shrink: 1` and an automatic minimum size of zero — the browser collapses both
    // to nothing to fit the rendered rows, and the scrollbar then measures the slice
    // instead of the list. The timeline's windowed scroller carries the same guard.
    // Structural, not visual: jsdom performs no flex layout, so this pins that the class
    // is applied, and the rule behind it lives in the stylesheet.
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);

    const pads = container.querySelectorAll('aside > div[aria-hidden=true]');
    expect(pads.length).toBe(2);
    for (const pad of pads) {
      expect(pad.classList.contains('members__pad')).toBe(true);
    }
  });

  it('renders a slice of a crowded room, not all of it', async () => {
    // The failure this exists for: 5,000 members painted 5,000 buttons, each with an
    // avatar. 400px of viewport plus 320px of overscan either side is ~24 rows.
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);

    const rendered = rowCount(container);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });

  it('keeps the scroll height honest with spacers', async () => {
    // The spacers are what stop the scrollbar from lying: the rendered content plus both
    // spacers must add up to the height the whole list would have had — one header plus
    // 600 rows.
    //
    // What this can and cannot catch, because an earlier version of it caught nothing:
    // it fails on a wrong ROW_PX or a bad slice (checked), and it is algebraically BLIND
    // to HEADER_PX — the bottom spacer is derived from the same total, so the header's
    // height cancels out whatever it is. That number is only checkable against a real
    // cascade, and `member-info.spec.mts` measures it in Chromium.
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);

    const [top, bottom] = spacers(container);
    const headerPx = container.querySelectorAll('.members__section-label')
      .length
      ? HEADER_PX
      : 0;
    const renderedPx = rowCount(container) * ROW_PX + headerPx;

    expect(top + renderedPx + bottom).toBe(HEADER_PX + 600 * ROW_PX);
    // And the spacers are actually carrying most of it — the identity above holds
    // trivially when nothing is windowed (0 + everything + 0), so on its own it would
    // pass with windowing switched off.
    expect(top + bottom).toBeGreaterThan(0);
  });

  it('moves the window down as the panel is scrolled', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);
    const firstAtTop = container
      .querySelector('.member__name')
      ?.textContent?.trim();

    const host = container.querySelector('aside')!;
    Object.defineProperty(host, 'scrollTop', { value: 8_000, writable: true });
    host.dispatchEvent(new Event('scroll'));
    TestBed.tick();

    const firstAfterScroll = container
      .querySelector('.member__name')
      ?.textContent?.trim();
    expect(firstAfterScroll).not.toBe(firstAtTop);
    // 8000px in at 44px a row is around row 180 — the exact row depends on overscan.
    expect(Number(firstAfterScroll?.replace('User ', ''))).toBeGreaterThan(100);
  });

  it('renders every section a multi-section room has, headers included', async () => {
    // Every other windowing fixture is one flat Member section, which cannot exercise the
    // section-boundary arithmetic at all: with one section `headerIndex` is 0 and
    // `firstRow` is 1, so the guard's two forms differ only when the window ENDS at index
    // 0 — never at a 400px viewport. Real rooms always have at least two sections, and a
    // section dropped at the window's edge leaves the rendered content HEADER_PX shorter
    // than the spacers assume, so the scrollbar drifts as the reader scrolls past it.
    const mixed = [
      ...Array.from({ length: 3 }, (_, i) =>
        member({
          userId: `@admin${i}:hs`,
          name: `Admin ${i}`,
          powerLevel: 100,
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        member({ userId: `@mod${i}:hs`, name: `Mod ${i}`, powerLevel: 50 }),
      ),
      ...crowd(200),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members: mixed },
      ...opts,
    });
    setViewport(container, 400);

    // The window starts at the top, so all three headers are inside it.
    expect(sectionLabels(container)).toEqual([
      'Admin — 3',
      'Moderator — 2',
      'Member — 200',
    ]);

    const [top, bottom] = spacers(container);
    const renderedPx =
      rowCount(container) * ROW_PX +
      container.querySelectorAll('.members__section-label').length * HEADER_PX;
    expect(top + renderedPx + bottom).toBe(3 * HEADER_PX + 205 * ROW_PX);
  });

  it("renders a section whose header is the window's last row", async () => {
    // The one arrangement that separates the boundary guard's two forms. Flat indices for
    // 3 admins + 2 moderators + members are: 0 Admin header, 1-3 admins, 4 Moderator
    // header, 5-6 moderators, 7 Member header, 8+ members — so the Member header sits at
    // 288..322px. A viewport small enough that 0 + viewport + 320px of overscan lands
    // inside that band makes `endIndex` exactly 7.
    //
    // Testing the first MEMBER row (index 8 > 7) instead of the header (7 > 7 is false)
    // drops the whole section, header included, while `computeWindow` has already counted
    // that header's height as rendered — leaving the content HEADER_PX shorter than the
    // spacers claim.
    const mixed = [
      ...Array.from({ length: 3 }, (_, i) =>
        member({
          userId: `@admin${i}:hs`,
          name: `Admin ${i}`,
          powerLevel: 100,
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        member({ userId: `@mod${i}:hs`, name: `Mod ${i}`, powerLevel: 50 }),
      ),
      ...crowd(200),
    ];
    const { container } = await render(MemberListComponent, {
      inputs: { members: mixed },
      ...opts,
    });
    setViewport(container, 1);

    expect(sectionLabels(container)).toContain('Member — 200');

    // And the spacers still account for exactly the whole list.
    const [top, bottom] = spacers(container);
    const renderedPx =
      rowCount(container) * ROW_PX +
      container.querySelectorAll('.members__section-label').length * HEADER_PX;
    expect(top + renderedPx + bottom).toBe(3 * HEADER_PX + 205 * ROW_PX);
  });

  it('keeps a section reachable when its header has scrolled away', async () => {
    // A group whose header is outside the window still renders its rows, and still
    // carries the accessible name — the header is visual, the group's name is not.
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);

    const host = container.querySelector('aside')!;
    Object.defineProperty(host, 'scrollTop', { value: 8_000, writable: true });
    host.dispatchEvent(new Event('scroll'));
    TestBed.tick();

    const group = container.querySelector('.members__section')!;
    expect(group.querySelector('.members__section-label')).toBeNull();
    expect(group.getAttribute('aria-label')).toBe('Member, 600 members');
  });

  it('windows the filtered list, not the full one', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: crowd(600) },
      ...opts,
    });
    setViewport(container, 400);

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=member-filter]',
    )!;
    input.value = 'User 5'; // User 5, 50-59, 500-599 → 111 rows
    input.dispatchEvent(new Event('input'));
    TestBed.tick();

    const [top, bottom] = spacers(container);
    const renderedPx = rowCount(container) * ROW_PX + HEADER_PX;
    expect(top + renderedPx + bottom).toBe(HEADER_PX + 111 * ROW_PX);
    expect(top + bottom).toBeGreaterThan(0);
  });
});
