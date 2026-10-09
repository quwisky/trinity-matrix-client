import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@trinity/testing';
import { type SpaceSummary } from '@trinity/data-access/room-library';
import { AvatarComponent } from '@trinity/components/generic-content';
import { By } from '@angular/platform-browser';
import { MockComponent, ngMocks } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { type RailUnreadChat } from './rail-unread-chats';
import { ServerRailComponent, type RailUnread } from './server-rail.component';

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

  it('puts the mention badge bottom-right of a single-account space', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': counts(5, 2) } }),
      },
    });
    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.getAttribute('data-variant')).toBe('danger');
    expect(badge.classList.contains('badge--bottom')).toBe(true);
    expect(badge.classList.contains('badge--top')).toBe(false);
  });

  it('moves the mention badge top-right beside an account badge', async () => {
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
    expect(badge.classList.contains('badge--top')).toBe(true);
    expect(badge.classList.contains('badge--bottom')).toBe(false);
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
  ...over,
});

describe('unread chats', () => {
  it('sits between Rooms and the separator', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: { entries: [unreadChat()], overflow: 0 },
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
        unreadChats: {
          entries: [
            unreadChat({
              selection: { accountId: '@ben:hs', roomId: '!c:hs' },
              label: 'Team · 3 unread · Ben',
            }),
          ],
          overflow: 0,
        },
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
        unreadChats: {
          entries: [
            unreadChat({ countLabel: '99+' }),
            unreadChat({
              key: 'k2',
              countLabel: null,
              label: 'Team · marked unread',
            }),
          ],
          overflow: 0,
        },
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
        unreadChats: {
          entries: [
            unreadChat({
              direct: true,
              accountBadge: {
                id: '@ben:hs',
                name: 'Ben',
                initial: 'B',
                avatarMxc: null,
              },
            }),
          ],
          overflow: 0,
        },
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

  it('offers +N for the rest, which opens Recent', async () => {
    const { fixture } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: { entries: [unreadChat()], overflow: 4 },
      },
      imports: [MockComponent(AvatarComponent)],
    });
    let recent = false;
    fixture.componentInstance.showRecent.subscribe(() => (recent = true));
    const more = screen.getByRole('button', {
      name: '4 more unread chats in Recent activity',
    });
    expect(more.textContent?.trim()).toBe('+4');
    more.click();
    expect(recent).toBe(true);
  });

  it('names a single remaining chat in the singular', async () => {
    await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: { entries: [unreadChat()], overflow: 1 },
      },
      imports: [MockComponent(AvatarComponent)],
    });
    expect(
      screen.getByRole('button', {
        name: '1 more unread chat in Recent activity',
      }),
    ).toBeTruthy();
  });

  it('caps the +N text at +99 while the label keeps the real count', async () => {
    const { fixture } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: { entries: [unreadChat()], overflow: 150 },
      },
      imports: [MockComponent(AvatarComponent)],
    });
    expect(fixture.componentInstance.overflowText(150)).toBe('+99');
    const more = screen.getByRole('button', {
      name: '150 more unread chats in Recent activity',
    });
    expect(more.textContent?.trim()).toBe('+99');
  });

  it('draws +N as a 48px pill with its own text style', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        activeAccountId: '@me:hs',
        unreadChats: { entries: [unreadChat()], overflow: 2 },
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
