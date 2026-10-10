import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@trinity/testing';
import { type SpaceSummary } from '@trinity/data-access/room-library';
import { AvatarComponent } from '@trinity/components/generic-content';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { MockComponent, ngMocks } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { type RailUnreadChat, type RailUnreadChats } from './rail-unread-chats';
import { ServerRailComponent, type RailUnread } from './server-rail.component';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'Space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

const counts = (unreadCount = 0, mentions = 0) => ({
  unread: unreadCount,
  mentions,
});

/** Build an unread object, overriding only the counts a test cares about. */
const unread = (over: Partial<RailUnread> = {}): RailUnread => ({
  recent: counts(),
  home: counts(),
  rooms: counts(),
  perSpace: {},
  ...over,
});

// Fixed pill order at the head of the rail: Recent, Home, Rooms, then one per space.
const RECENT = 0;
const HOME = 1;
const ROOMS = 2;
const FIRST_SPACE = 3;

describe('ServerRailComponent', () => {
  it('renders Recent, Home, Rooms plus a pill per space', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!a:hs', name: 'Alpha' }),
          space({ id: '!b:hs', name: 'Beta' }),
        ],
      },
      imports: [MockComponent(AvatarComponent)],
    });

    expect(container.querySelector('.pill.recent')).toBeTruthy();
    expect(container.querySelector('.pill.home')).toBeTruthy();
    expect(container.querySelector('.pill.rooms')).toBeTruthy();
    const spacePills = container.querySelectorAll(
      '.pill:not(.recent):not(.home):not(.add):not(.rooms):not(.unread-chat)',
    );
    expect(spacePills.length).toBe(2);
  });

  it('emits showRecent when the Recent pill is clicked', async () => {
    const { fixture } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let shown = false;
    fixture.componentInstance.showRecent.subscribe(() => (shown = true));
    screen.getByTestId('rail-recent').click();

    expect(shown).toBe(true);
  });

  it('emits selectSpace(null) when Home is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { activeAccountId: '@me:hs' },
      imports: [MockComponent(AvatarComponent)],
    });

    let selected: unknown = 'unset';
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    container.querySelector<HTMLElement>('.pill.home')!.click();

    expect(selected).toEqual({ spaceId: null, accountId: '@me:hs' });
  });

  it('emits selectSpace(spaceId) when a space pill is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        spaces: [space({ id: '!s:hs', accountId: '@owner:hs' })],
      },
      imports: [MockComponent(AvatarComponent)],
    });

    let selected: unknown = null;
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    container
      .querySelector<HTMLElement>(
        '.pill:not(.recent):not(.home):not(.add):not(.rooms):not(.unread-chat)',
      )!
      .click();

    expect(selected).toEqual({ spaceId: '!s:hs', accountId: '@owner:hs' });
  });

  it('emits createSpace when the add ("+") pill is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let created = false;
    fixture.componentInstance.createSpace.subscribe(() => (created = true));
    const add = container.querySelector<HTMLButtonElement>('.pill.add')!;
    expect(add.disabled).toBe(false); // the affordance is enabled now
    add.click();

    expect(created).toBe(true);
  });

  it('lights Recent while its view is active and dims Home', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { recentActive: true },
      imports: [MockComponent(AvatarComponent)],
    });

    const items = container.querySelectorAll('.item');
    expect(items[RECENT].classList.contains('active')).toBe(true);
    expect(items[HOME].classList.contains('active')).toBe(false);

    // Leaving Recent hands the active marker back to Home (no space, no Rooms view).
    fixture.componentRef.setInput('recentActive', false);
    fixture.detectChanges();
    expect(items[RECENT].classList.contains('active')).toBe(false);
    expect(items[HOME].classList.contains('active')).toBe(true);
  });

  it('marks the active space (Home active when nothing else is)', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s:hs' })] },
      imports: [MockComponent(AvatarComponent)],
    });

    // No Recent, no Rooms, no space → Home is the active item.
    const items = container.querySelectorAll('.item');
    expect(items[HOME].classList.contains('active')).toBe(true);

    // Selecting the space moves the active marker to its item.
    fixture.componentRef.setInput('activeSpaceId', '!s:hs');
    fixture.detectChanges();
    expect(items[RECENT].classList.contains('active')).toBe(false);
    expect(items[HOME].classList.contains('active')).toBe(false);
    expect(items[ROOMS].classList.contains('active')).toBe(false);
    expect(items[FIRST_SPACE].classList.contains('active')).toBe(true);
  });

  it('emits showRooms when the Rooms pill is clicked', async () => {
    const { fixture } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let shown = false;
    fixture.componentInstance.showRooms.subscribe(() => (shown = true));
    screen.getByTestId('rail-rooms').click();

    expect(shown).toBe(true);
  });

  it('marks the Rooms view active and deactivates Home when roomsActive is set', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });
    const items = container.querySelectorAll('.item');

    // Default (no Rooms view): Home active, Rooms inactive.
    expect(items[HOME].classList.contains('active')).toBe(true);
    expect(items[ROOMS].classList.contains('active')).toBe(false);

    fixture.componentRef.setInput('roomsActive', true);
    fixture.detectChanges();
    expect(items[HOME].classList.contains('active')).toBe(false);
    expect(items[ROOMS].classList.contains('active')).toBe(true);
  });

  it('shows a mention badge on the Recent, Home, Rooms and space items', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({
          recent: counts(9, 9),
          home: counts(3, 3),
          rooms: counts(7, 7),
          perSpace: { '!s:hs': counts(12, 12) },
        }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const items = container.querySelectorAll('.item');
    const text = (i: number) =>
      items[i].querySelector('[trnBadge]')?.textContent?.trim();
    expect([text(RECENT), text(HOME), text(ROOMS), text(FIRST_SPACE)]).toEqual([
      '9',
      '3',
      '7',
      '12',
    ]);
  });

  it('shows the unread dot and no badge for unread without mentions', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': counts(3, 0) } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const item = container.querySelectorAll('.item')[FIRST_SPACE];
    expect(item.classList.contains('item--unread')).toBe(true);
    expect(item.querySelector('[trnBadge]')).toBeNull();
  });

  it('shows neither dot nor badge with nothing unread, and no dot when mentioned', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!a:hs' }), space({ id: '!b:hs' })],
        unread: unread({ perSpace: { '!b:hs': counts(5, 2) } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    expect(container.querySelector('[trnBadge]')?.textContent?.trim()).toBe(
      '2',
    );
    expect(container.querySelectorAll('[trnBadge]').length).toBe(1);
    expect(container.querySelector('.item--unread')).toBeNull();
  });

  it('names rail pills with their unread state', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!a:hs', name: 'Alpha' }),
          space({ id: '!b:hs', name: 'Beta' }),
          space({ id: '!c:hs', name: 'Gamma' }),
        ],
        unread: unread({
          home: counts(4, 0),
          rooms: counts(5, 2),
          perSpace: { '!a:hs': counts(3, 0), '!b:hs': counts(5, 2) },
        }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const labels = [...container.querySelectorAll('.item > .pill')].map((p) =>
      p.getAttribute('aria-label'),
    );
    expect(labels.slice(0, 6)).toEqual([
      'Recent activity',
      'Direct messages, unread',
      'Rooms, 2 mentions',
      'Alpha, unread',
      'Beta, 2 mentions',
      'Gamma',
    ]);
  });

  it('puts the mention badge top-right of a single-account space', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': counts(5, 2) } }),
      },
    });
    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.getAttribute('data-variant')).toBe('danger');
    expect(badge.classList.contains('rail-count')).toBe(true);
  });

  it('keeps the mention badge top-right beside an account badge', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs', accountId: '@me:hs' })],
        unread: unread({ perSpace: { '!s:hs': counts(5, 2) } }),
        accountBadges: new Map([
          ['@me:hs', { id: '@me:hs', initial: 'M', name: 'Me' }],
        ]),
      },
    });
    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.classList.contains('rail-count')).toBe(true);
    expect(
      container.querySelector('[data-testid="account-badge"]'),
    ).toBeTruthy();
  });

  it('caps a mention badge at 99+', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { unread: unread({ home: counts(250, 250) }) },
      imports: [MockComponent(AvatarComponent)],
    });
    expect(container.querySelector('[trnBadge]')?.textContent?.trim()).toBe(
      '99+',
    );
  });

  it('updates a space badge when its mentions transition to 0', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': counts(6, 6) } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    const item = () => container.querySelectorAll('.item')[FIRST_SPACE];
    expect(item().querySelector('[trnBadge]')?.textContent?.trim()).toBe('6');

    fixture.componentRef.setInput(
      'unread',
      unread({ perSpace: { '!s:hs': counts(0, 0) } }),
    );
    fixture.detectChanges();
    expect(item().querySelector('[trnBadge]')).toBeNull();
  });

  it('marks the selected item indicator', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s:hs' })], activeSpaceId: '!s:hs' },
      imports: [MockComponent(AvatarComponent)],
    });
    const selected = container.querySelectorAll('.indicator--selected');
    expect(selected.length).toBe(1);
    expect(selected[0].parentElement).toBe(
      container.querySelectorAll('.item')[FIRST_SPACE],
    );
  });

  it('renders the space pill as an icon button', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { spaces: [space()] },
      imports: [MockComponent(AvatarComponent)],
    });
    const pill = container
      .querySelectorAll('.item')
      [FIRST_SPACE].querySelector('button')!;
    expect(pill.hasAttribute('data-trn-icon-button')).toBe(true);
  });

  it('keeps the space pill 48px with the place radius inside the icon-button recipe', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { spaces: [space()] },
      imports: [MockComponent(AvatarComponent)],
    });
    const pill = container
      .querySelectorAll('.item')
      [FIRST_SPACE].querySelector('button')!;
    // The recipe's own size-8 and the global icon-button radius would otherwise shrink
    // the pill under its 48px avatar and round it differently.
    expect(pill.classList.contains('size-12')).toBe(true);
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    expect(css).toMatch(
      /--trn-icon-button-radius:\s*var\(--trinity-shape-place-radius\)/,
    );
  });

  it('moves the account badge to the bottom-right of the rail avatar', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    expect(css).toMatch(/--trn-account-badge-left:\s*auto/);
    expect(css).toMatch(/--trn-account-badge-right:\s*-2px/);
  });

  it('keeps the selected pill over the unread dot and hover pill', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    // Specificity of the unread rule is (item, indicator) = 2 classes; the selected rule
    // must have at least that many and come after it, or the 8px dot wins.
    const unreadAt = css.indexOf('.item--unread .indicator {');
    const selectedAt = css.indexOf('.item .indicator--selected,');
    expect(unreadAt).toBeGreaterThan(-1);
    expect(selectedAt).toBeGreaterThan(unreadAt);
    expect(css.indexOf('.item:hover .indicator--selected')).toBeGreaterThan(
      css.indexOf('.item:hover .indicator {'),
    );
  });

  it('sizes the indicator 32px selected, 20px on hover and 8px for unread', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    const tokens = readFileSync(
      join(
        import.meta.dirname,
        '../../../../../theme-foundation/styles/internal/variables.scss',
      ),
      'utf8',
    );
    const height = (selector: string) =>
      css.match(
        new RegExp(
          `${selector.replace(/[.]/g, '\\.')}\\s*\\{\\s*height:\\s*([^;]+);`,
        ),
      )?.[1];
    expect(height('.item--unread .indicator')).toBe(
      'var(--trinity-rail-indicator-unread)',
    );
    expect(height('.item:hover .indicator')).toBe(
      'var(--trinity-rail-indicator-hover)',
    );
    expect(height('.item:hover .indicator--selected')).toBe(
      'var(--trinity-rail-indicator-selected)',
    );
    expect(tokens).toContain('--trinity-rail-indicator-selected: 32px');
    expect(tokens).toContain('--trinity-rail-indicator-hover: 20px');
    expect(tokens).toContain('--trinity-rail-indicator-unread: 8px');
  });

  it('badges each space pill with its owning account in the mixed view', async () => {
    // Use the real AvatarComponent (its badge renders without the image resolver) so the
    // account-badge overlay is actually present.
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!s1:hs', accountId: '@me:hs' }),
          space({ id: '!s2:hs', accountId: '@alt:hs' }),
        ],
        accountBadges: new Map([
          ['@me:hs', { id: '@me:hs', initial: 'M', name: 'Me' }],
          ['@alt:hs', { id: '@alt:hs', initial: 'A', name: 'Alt' }],
        ]),
      },
    });

    expect(
      container.querySelectorAll('[data-testid="account-badge"]').length,
    ).toBe(2);
  });

  it('shows no space-pill badge without an account-badge map', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s1:hs' })] },
    });
    expect(container.querySelector('[data-testid="account-badge"]')).toBeNull();
  });

  it('keeps space avatars place-shaped across active view changes', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s1:hs' })] },
    });
    const avatar = () => container.querySelector('trn-avatar');

    expect(avatar()?.getAttribute('data-shape')).toBe('place');

    fixture.componentRef.setInput('activeSpaceId', '!s1:hs');
    await fixture.whenStable();
    expect(avatar()?.getAttribute('data-shape')).toBe('place');

    fixture.componentRef.setInput('roomsActive', true);
    await fixture.whenStable();
    expect(avatar()?.getAttribute('data-shape')).toBe('place');
  });
});

const unreadChat = (over: Partial<RailUnreadChat> = {}): RailUnreadChat => ({
  key: '@me:hs\u0000!c:hs',
  selection: { accountId: '@me:hs', roomId: '!c:hs' },
  name: 'Team',
  initial: 'T',
  avatarMxc: null,
  direct: false,
  countLabel: '3',
  accountBadge: null,
  label: 'Team · 3 unread',
  activityTs: 0,
  ...over,
});

/** The rail's unread chats: `entries` shown, `more` behind "+N". */
const railChats = (
  entries: RailUnreadChat[],
  more: RailUnreadChat[] = [],
): RailUnreadChats => ({
  entries,
  overflow: more.length,
  overflowEntries: more,
});

/** `count` overflow chats, each its own room. */
const moreChats = (count: number): RailUnreadChat[] =>
  Array.from({ length: count }, (_, i) =>
    unreadChat({
      key: `@me:hs\u0000!m${i}:hs`,
      selection: { accountId: '@me:hs', roomId: `!m${i}:hs` },
      name: `More ${i}`,
      label: `More ${i} · 1 unread`,
      countLabel: '1',
    }),
  );

describe('unread chats', () => {
  it('sits between Rooms and the separator', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([unreadChat()]),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    const fixed = container.querySelector('nav.rail > .rail-fixed')!;
    const scroll = container.querySelector('nav.rail > .rail-scroll')!;
    expect(fixed.lastElementChild?.querySelector('.pill.rooms')).toBeTruthy();
    expect(
      scroll.firstElementChild?.matches('[data-testid=rail-unread-chats]'),
    ).toBe(true);
    expect(scroll.children[1].matches('.separator')).toBe(true);
  });

  it('keeps Recent, Home and Rooms pinned outside the scrolling part', async () => {
    const { container, getByTestId } = await render(ServerRailComponent, {
      inputs: { spaces: [space()] },
      imports: [MockComponent(AvatarComponent)],
    });
    const fixed = container.querySelector('.rail-fixed')!;
    expect(fixed.querySelector('.rail-scroll')).toBeNull();
    expect(
      fixed.querySelectorAll('.pill.recent, .pill.home, .pill.rooms'),
    ).toHaveLength(3);
    expect(fixed.querySelector('.pill.add')).toBeNull();
    const scroll = getByTestId('rail-scroll');
    expect(scroll.querySelector('.pill.add')).toBeTruthy();
    expect(
      scroll.querySelector('.pill.recent, .pill.home, .pill.rooms'),
    ).toBeNull();
  });

  it('names each chat and opens it on its own account', async () => {
    const { fixture } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([
          unreadChat({
            selection: { accountId: '@ben:hs', roomId: '!c:hs' },
            label: 'Team · 3 unread · Ben',
          }),
        ]),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    const opened: ExactRoomSelection[] = [];
    fixture.componentInstance.openUnreadChat.subscribe((s) => opened.push(s));
    screen.getByRole('button', { name: 'Team · 3 unread · Ben' }).click();
    expect(opened).toEqual([{ accountId: '@ben:hs', roomId: '!c:hs' }]);
  });

  it('shows the count, or a dot for a chat only marked unread', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([
          unreadChat({ countLabel: '99+' }),
          unreadChat({
            key: 'k2',
            countLabel: null,
            label: 'Team · marked unread',
          }),
        ]),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    expect(
      container
        .querySelector('[data-testid=rail-unread-count]')
        ?.textContent?.trim(),
    ).toBe('99+');
    expect(
      container.querySelectorAll('[data-testid=rail-unread-dot]'),
    ).toHaveLength(1);
  });

  it('hands the account badge and avatar shape to the avatar', async () => {
    const { fixture } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([
          unreadChat({
            direct: true,
            accountBadge: {
              id: '@ben:hs',
              name: 'Ben',
              initial: 'B',
              avatarMxc: null,
            },
          }),
        ]),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    const avatar = ngMocks.find(
      fixture.debugElement.query(By.css('[data-testid=rail-unread-chats]')),
      AvatarComponent,
    ).componentInstance;
    expect(avatar.accountBadge()).toMatchObject({ id: '@ben:hs' });
    expect(avatar.shape()).toBe('person');
  });

  it('names +N for the chats it holds', async () => {
    await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([unreadChat()], moreChats(4)),
      },
    });
    const more = screen.getByRole('button', { name: '4 more unread chats' });
    expect(more.textContent?.trim()).toBe('+4');
  });

  it('names a single remaining chat in the singular', async () => {
    await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([unreadChat()], moreChats(1)),
      },
    });
    expect(
      screen.getByRole('button', { name: '1 more unread chat' }),
    ).toBeTruthy();
  });

  it('caps the +N text at +99 while the label keeps the real count', async () => {
    const { fixture } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([unreadChat()], moreChats(150)),
      },
    });
    expect(fixture.componentInstance.overflowText(150)).toBe('+99');
    const more = screen.getByRole('button', {
      name: '150 more unread chats',
    });
    expect(more.textContent?.trim()).toBe('+99');
  });

  it('draws +N as a 48px pill with its own text style', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: railChats([unreadChat()], moreChats(2)),
      },
      imports: [MockComponent(AvatarComponent)],
    });
    const more = screen.getByTestId('rail-unread-overflow');
    expect(more.classList.contains('size-12')).toBe(true);
    // The label recipe's own height must be merged away, not just outranked.
    expect(more.classList.contains('h-8')).toBe(false);
    expect(more.querySelector('.overflow-text')?.textContent?.trim()).toBe(
      '+2',
    );
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    expect(css).toMatch(/\.overflow-text\s*\{[^}]*font-size:[^}]*font-weight:/);
    expect(container.querySelector('.pill.overflow')).toBe(more);
  });

  it('keeps room above the first scrolling row inside the scroller', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'server-rail.component.scss'),
      'utf8',
    );
    // Every rule whose selector list names the class, so grouped selectors count too.
    const body = (selector: string) =>
      [
        ...css.matchAll(
          new RegExp(
            `\\n  [^\\n{}]*${selector}\\s*\\{([\\s\\S]*?)\\n  \\}`,
            'g',
          ),
        ),
      ]
        .map((m) => m[1])
        .join('\n');
    expect(body('\\.rail-scroll')).toMatch(
      /padding-block:\s*var\(--trinity-density-shell-gap\)/,
    );
    expect(body('\\.rail-scroll')).toContain(
      'scroll-padding-block-start: var(--trinity-density-shell-gap)',
    );
    expect(body('\\.rail-fixed')).not.toContain('padding-block-end');
  });

  it('renders no section without unread chats', async () => {
    const { container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });
    expect(
      container.querySelector('[data-testid=rail-unread-chats]'),
    ).toBeNull();
  });
});

const ben = { id: '@ben:hs', name: 'Ben', initial: 'B', avatarMxc: null };
const NOW = Date.UTC(2026, 9, 10, 12);

/** Three chats behind "+3": a badged DM, a marked-unread room and a busy room. */
const overflowChats = (): RailUnreadChat[] => [
  unreadChat({
    key: '@ben:hs\u0000!dm:hs',
    selection: { accountId: '@ben:hs', roomId: '!dm:hs' },
    name: 'Alex',
    direct: true,
    countLabel: '1',
    accountBadge: ben,
    label: 'Alex · 1 unread · Ben',
    activityTs: NOW - 2 * 60 * 60_000,
  }),
  unreadChat({
    key: '@me:hs\u0000!plan:hs',
    selection: { accountId: '@me:hs', roomId: '!plan:hs' },
    name: 'Planning',
    countLabel: null,
    label: 'Planning · marked unread',
    activityTs: NOW - 5 * 60_000,
  }),
  unreadChat({
    key: '@me:hs\u0000!busy:hs',
    selection: { accountId: '@me:hs', roomId: '!busy:hs' },
    name: 'Busy',
    countLabel: '99+',
    label: 'Busy · 120 unread',
    activityTs: NOW - 3 * 60_000,
  }),
];

async function renderOverflow() {
  const result = await render(ServerRailComponent, {
    inputs: {
      activeAccountId: '@me:hs',
      unreadChats: railChats([unreadChat()], overflowChats()),
    },
  });
  const opened: ExactRoomSelection[] = [];
  let recent = 0;
  result.fixture.componentInstance.openUnreadChat.subscribe((s) =>
    opened.push(s),
  );
  result.fixture.componentInstance.showRecent.subscribe(() => recent++);
  const trigger = screen.getByTestId<HTMLButtonElement>('rail-unread-overflow');
  return { ...result, opened, recent: () => recent, trigger };
}

/** The rows of whichever overflow list is open, in order. */
const overflowRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid=rail-overflow-chat]'),
];

const overflowList = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid=rail-overflow-list]');

describe('unread chats beyond the cap, at desktop width', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('opens a menu of the remaining chats from +N', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { fixture, trigger } = await renderOverflow();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    await fixture.whenStable();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: '3 more unread chats' });
    expect(menu.textContent).toContain('3 more unread chats');
    expect(overflowRows().map((row) => row.getAttribute('aria-label'))).toEqual(
      [
        'Alex · 1 unread · Ben',
        'Planning · marked unread',
        'Busy · 120 unread',
      ],
    );
  });

  it('draws each row like its rail entry, with account and last activity', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { fixture, trigger } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();

    const [alex, planning, busy] = overflowRows();
    const detail = (row: HTMLElement) =>
      row
        .querySelector('[data-testid=rail-overflow-detail]')
        ?.textContent?.trim();
    expect(detail(alex)).toBe('Ben · 2 hr. ago');
    expect(detail(planning)).toBe('Marked unread');
    expect(detail(busy)).toBe('3 min. ago');
    expect(
      busy.querySelector('[data-testid=rail-overflow-count]')?.textContent,
    ).toContain('99+');
    expect(
      planning.querySelector('[data-testid=rail-overflow-dot]'),
    ).toBeTruthy();
    expect(
      planning.querySelector('[data-testid=rail-overflow-count]'),
    ).toBeNull();
    const avatar = alex.querySelector('trn-avatar');
    expect(avatar?.getAttribute('data-shape')).toBe('person');
    expect(
      planning.querySelector('trn-avatar')?.getAttribute('data-shape'),
    ).toBe('place');
  });

  it("opens a row's chat on its own account and closes", async () => {
    const { fixture, trigger, opened } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();

    overflowRows()[0].click();
    await fixture.whenStable();

    expect(opened).toEqual([{ accountId: '@ben:hs', roomId: '!dm:hs' }]);
    expect(overflowList()).toBeNull();
  });

  it('keeps Show all in Recent activity as the way to Recent', async () => {
    const { fixture, trigger, recent, opened } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();

    screen
      .getByRole('menuitem', { name: 'Show all in Recent activity' })
      .click();
    await fixture.whenStable();

    expect(recent()).toBe(1);
    expect(opened).toEqual([]);
    expect(overflowList()).toBeNull();
  });

  it('opens from the keyboard and moves between rows with the arrow keys', async () => {
    const { fixture, trigger } = await renderOverflow();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown', keyCode: 40 });
    await fixture.whenStable();
    const rows = overflowRows();
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0], { key: 'ArrowDown', keyCode: 40 });
    await fixture.whenStable();

    expect(document.activeElement).toBe(rows[1]);
  });

  it('closes on Escape and returns focus to +N', async () => {
    const { fixture, trigger } = await renderOverflow();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown', keyCode: 40 });
    await fixture.whenStable();

    fireEvent.keyDown(overflowRows()[0], { key: 'Escape', keyCode: 27 });
    await fixture.whenStable();

    expect(overflowList()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});

describe('unread chats beyond the cap, on a phone', () => {
  afterEach(() => {
    platform.mobile = false;
    TestBed.resetTestingModule();
  });

  it('shows the remaining chats in a bottom sheet', async () => {
    platform.mobile = true;
    const { fixture, trigger } = await renderOverflow();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    await fixture.whenStable();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const sheet = screen.getByRole('dialog', { name: '3 more unread chats' });
    expect(sheet.querySelector('trn-sheet-frame')).toBeTruthy();
    expect(overflowRows().map((row) => row.getAttribute('aria-label'))).toEqual(
      [
        'Alex · 1 unread · Ben',
        'Planning · marked unread',
        'Busy · 120 unread',
      ],
    );
  });

  it("opens a row's chat on its own account and closes", async () => {
    platform.mobile = true;
    const { fixture, trigger, opened } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();

    overflowRows()[1].click();
    await fixture.whenStable();

    expect(opened).toEqual([{ accountId: '@me:hs', roomId: '!plan:hs' }]);
    expect(overflowList()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps Show all in Recent activity as the way to Recent', async () => {
    platform.mobile = true;
    const { fixture, trigger, recent } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();

    screen.getByRole('button', { name: 'Show all in Recent activity' }).click();
    await fixture.whenStable();

    expect(recent()).toBe(1);
    expect(overflowList()).toBeNull();
  });

  it('closes on Escape and returns focus to +N', async () => {
    platform.mobile = true;
    const { fixture, trigger } = await renderOverflow();
    trigger.focus();
    trigger.click();
    await fixture.whenStable();

    fireEvent.keyDown(overflowRows()[0], { key: 'Escape', keyCode: 27 });
    await fixture.whenStable();

    expect(overflowList()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('names the sheet by its live title as the count changes', async () => {
    platform.mobile = true;
    const { fixture, trigger } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();
    const sheet = screen.getByRole('dialog', { name: '3 more unread chats' });
    expect(sheet.hasAttribute('aria-label')).toBe(false);
    const title = document.getElementById(
      sheet.getAttribute('aria-labelledby') ?? '',
    );
    expect(title?.textContent?.trim()).toBe('3 more unread chats');

    fixture.componentRef.setInput(
      'unreadChats',
      railChats([unreadChat()], overflowChats().slice(0, 2)),
    );
    await fixture.whenStable();

    expect(screen.getByRole('dialog', { name: '2 more unread chats' })).toBe(
      sheet,
    );
  });

  it('closes once no chats are left behind +N', async () => {
    platform.mobile = true;
    const { fixture, trigger } = await renderOverflow();
    trigger.click();
    await fixture.whenStable();
    expect(overflowList()).toBeTruthy();

    fixture.componentRef.setInput('unreadChats', railChats([unreadChat()]));
    await fixture.whenStable();

    expect(overflowList()).toBeNull();
  });
});
