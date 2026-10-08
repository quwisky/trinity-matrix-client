import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RoomSummary } from '@trinity/data-access/room-library';
import { render, type ComponentInput } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  RoomHeaderComponent,
  type RoomHeaderAction,
} from './room-header.component';

const ROOM: RoomSummary = {
  id: '!r:hs',
  accountId: '@me:hs',
  accountIds: ['@me:hs'],
  name: 'General',
  initial: 'G',
  avatarMxc: null,
  topic: '',
  memberCount: 2,
  encrypted: false,
  unreadCount: 0,
  highlightCount: 0,
  hasUnread: false,
  markedUnread: false,
  lastMessage: '',
  activityTs: 0,
  favourite: false,
  lowPriority: false,
};

async function build(inputs: Record<string, unknown> = {}) {
  const actions: RoomHeaderAction[] = [];
  const result = await render(RoomHeaderComponent, {
    inputs: { room: ROOM, ...inputs } as ComponentInput<RoomHeaderComponent>,
    on: { action: (a: RoomHeaderAction) => actions.push(a) },
  });
  const root = result.container as HTMLElement;
  const byId = (id: string) =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { ...result, root, byId, actions };
}

const topicRoom = (topic: string): RoomSummary => ({ ...ROOM, topic });

describe('RoomHeaderComponent pinned-messages state', () => {
  it('renders no count badge, and leaves the overflow button plain', async () => {
    const { root, byId } = await build({ pinnedCount: 3 });
    expect(root.querySelector('.header-pin__badge')).toBeNull();
    expect(byId('room-actions-overflow')?.textContent?.trim()).toBe('');
    expect(
      byId('room-actions-overflow')
        ?.querySelector('trn-icon')
        ?.getAttribute('data-variant'),
    ).toBeNull();
  });

  it.each([
    [0, null],
    [2, 'accent'],
  ])(
    'with %i pins the pin icon variant is %s',
    async (pinnedCount, variant) => {
      const { byId } = await build({ pinnedCount });
      expect(
        byId('open-pinned')
          ?.querySelector('trn-icon')
          ?.getAttribute('data-variant') ?? null,
      ).toBe(variant);
    },
  );

  it.each([
    [2, 'Pinned messages (2)'],
    [0, 'Pinned messages'],
  ])('with %i pins the pin button is named %s', async (pinnedCount, name) => {
    const { byId } = await build({ pinnedCount });
    expect(byId('open-pinned')?.getAttribute('aria-label')).toBe(name);
  });
});

describe('RoomHeaderComponent title', () => {
  it('shows a 24px decorative avatar, no hash, and a divider with the topic', async () => {
    const { root, byId, fixture } = await build({
      room: topicRoom('Release planning'),
    });
    const avatar = root.querySelector('[data-testid="room-title"] trn-avatar');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(
      fixture.debugElement
        .query((d) => d.nativeElement === avatar)
        .componentInstance.exactSize(),
    ).toBe(24);
    expect(root.querySelector('.title-hash')).toBeNull();
    expect(byId('room-topic')?.textContent?.trim()).toBe('Release planning');
    expect(byId('room-topic-divider')).not.toBeNull();
  });

  it('omits the divider and topic when the topic is empty', async () => {
    const { byId } = await build();
    expect(byId('room-topic')).toBeNull();
    expect(byId('room-topic-divider')).toBeNull();
  });

  it('points the topic button at the popover', async () => {
    const { root, byId } = await build({ room: topicRoom('Release planning') });
    expect(byId('room-topic')?.tagName).toBe('BUTTON');
    expect(byId('room-topic')?.getAttribute('popovertarget')).toBe(
      'room-topic-popover',
    );
    expect(root.querySelector('#room-topic-popover')).not.toBeNull();
  });

  it('shows markup in the topic as text and links as safe anchors', async () => {
    const { root } = await build({
      room: topicRoom('<img src=x onerror=alert(1)> see https://example.org'),
    });
    const popover = root.querySelector('#room-topic-popover') as HTMLElement;
    expect(popover.querySelector('img')).toBeNull();
    expect(popover.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(
      popover.querySelectorAll(
        'a[href="https://example.org"][target="_blank"][rel~="noopener"]',
      ),
    ).toHaveLength(1);
  });

  it('treats a literal anchor tag in the topic as text, not a link', async () => {
    const { root } = await build({
      room: topicRoom('<a href="javascript:alert(1)">hi</a>'),
    });
    const popover = root.querySelector('#room-topic-popover') as HTMLElement;
    expect(popover.querySelector('a')).toBeNull();
    expect(popover.textContent).toContain(
      '<a href="javascript:alert(1)">hi</a>',
    );
  });

  it.each([
    ['Release planning', true],
    ['', false],
  ])('with topic %j the name cap is %s', async (topic, capped) => {
    const { root } = await build({ room: topicRoom(topic) });
    expect(
      root
        .querySelector('.title-room')
        ?.classList.contains('title-room--topic'),
    ).toBe(capped);
  });

  it('keeps the heading named but visually empty with no room open', async () => {
    const { root } = await build({ room: null });
    const h1 = root.querySelector('h1') as HTMLElement;
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(h1.querySelector('.sr-only')?.textContent?.trim()).toBe('Trinity');
    expect(h1.querySelector('[data-testid="room-title"]')).toBeNull();
    h1.querySelector('.sr-only')?.remove();
    expect(h1.textContent?.trim()).toBe('');
  });

  it('does not render the topic when compact', async () => {
    const { byId } = await build({
      room: topicRoom('Release planning'),
      compact: true,
    });
    expect(byId('room-topic')).toBeNull();
  });

  it('shows no acting-as chip without an identity', async () => {
    expect((await build()).byId('active-account-chip')).toBeNull();
  });

  it('names the identity in the acting-as chip', async () => {
    const { byId } = await build({
      actingAs: { userId: '@me:hs', name: 'Me', initial: 'M', avatarMxc: null },
    });
    expect(byId('active-account-chip')?.getAttribute('aria-label')).toBe(
      'Acting as Me',
    );
    expect(byId('active-account-chip')?.getAttribute('title')).toBe('@me:hs');
  });
});

describe('RoomHeaderComponent topic popover stylesheet', () => {
  const scss = readFileSync(
    join(__dirname, 'room-header.component.scss'),
    'utf8',
  );

  it('applies anchor positioning and the margin reset only where supported', () => {
    const supports = scss.match(
      /@supports \(top: anchor\(bottom\)\) \{[\s\S]*?\n {2}\}/,
    );
    expect(supports).not.toBeNull();
    for (const decl of ['position-anchor', 'top: anchor(', 'margin: 0']) {
      expect(supports![0]).toContain(decl);
    }
    expect(scss.replace(supports![0], '')).not.toMatch(/anchor\(|margin: 0;/);
  });

  it('leaves the closed popover to the UA display: none', () => {
    const rule = scss.match(/\n {2}\.topic-popover \{[\s\S]*?\n {2}\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/\bdisplay:/);
  });

  it('flips the anchored popover inline when it would overflow', () => {
    expect(scss).toContain('position-try-fallbacks: flip-inline');
  });
});

describe('RoomHeaderComponent actions and search field', () => {
  it('orders threads, pinned, members, the search field, then the overflow', async () => {
    const { byId } = await build();
    const actions = [
      'open-threads',
      'open-pinned',
      'toggle-members',
      'header-search',
      'room-actions-overflow',
    ].map((id) => byId(id) as HTMLElement);
    actions.forEach((el, i) => {
      if (i > 0) {
        expect(
          actions[i - 1].compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });
  });

  it('moves invite and room settings into the overflow menu', async () => {
    const { byId } = await build();
    expect(byId('invite-people')).toBeNull();
    expect(byId('open-room-settings')).toBeNull();
    const source = readFileSync(
      join(__dirname, 'room-header.component.html'),
      'utf8',
    );
    expect(source).toContain('data-testid="overflow-invite-people"');
    expect(source).toContain('data-testid="overflow-open-room-settings"');
  });

  it('marks only the open panel button as pressed', async () => {
    const { byId, fixture } = await build();
    const pressed = () =>
      ['open-threads', 'open-pinned', 'toggle-members'].map((id) =>
        byId(id)?.getAttribute('aria-pressed'),
      );
    expect(pressed()).toEqual(['false', 'false', 'false']);
    fixture.componentRef.setInput('surfaceKind', 'threads');
    fixture.detectChanges();
    expect(pressed()).toEqual(['true', 'false', 'false']);
    fixture.componentRef.setInput('surfaceKind', 'pinned');
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'true', 'false']);
    fixture.componentRef.setInput('surfaceKind', null);
    fixture.componentRef.setInput('membersVisible', true);
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'false', 'true']);
  });

  it('keeps the threads button pressed while a single thread is open', async () => {
    const { byId } = await build({ surfaceKind: 'thread' });
    expect(byId('open-threads')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the inline field only beside static panels, else the icon', async () => {
    const { byId } = await build();
    expect(byId('header-search')?.classList).toContain('max-members:hidden');
    expect(byId('search-messages')?.classList).toContain('members:hidden');
  });

  it('names the field after the room', async () => {
    const { byId } = await build();
    expect(byId('header-search')?.getAttribute('placeholder')).toBe(
      'Search General',
    );
  });

  it.each([
    ['back-to-rooms', { type: 'back' }],
    ['open-threads', { type: 'threads' }],
    ['open-pinned', { type: 'pinned' }],
    ['toggle-members', { type: 'members' }],
    ['search-messages', { type: 'search' }],
  ] as const)('emits %s as an action', async (id, expected) => {
    const { byId, actions } = await build();
    byId(id)?.click();
    expect(actions).toEqual([expected]);
  });

  it.each([
    ['overflow-invite-people', 'invite'],
    ['overflow-open-room-settings', 'settings'],
    ['overflow-open-pinned', 'pinned'],
    ['overflow-jump-to-date', 'jump-to-date'],
    ['overflow-toggle-members', 'members'],
    ['overflow-open-system-status', 'system-status'],
  ])('emits the %s menu item as %s', async (id, type) => {
    const { byId, actions } = await build({
      invitePermission: { available: true, reason: null },
    });
    byId('room-actions-overflow')?.click();
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
    expect(actions).toEqual([{ type }]);
  });

  it('flags a system-status problem in the overflow menu', async () => {
    const { byId } = await build({ systemStatusProblems: true });
    byId('room-actions-overflow')?.click();
    expect(
      document.querySelector(
        '[data-testid="overflow-open-system-status"] [aria-label="Needs attention"]',
      ),
    ).not.toBeNull();
  });

  async function type(value: string, inputs: Record<string, unknown> = {}) {
    const built = await build(inputs);
    const field = built.byId('header-search') as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    built.fixture.detectChanges();
    return { ...built, field };
  }

  it('writes the typed query to the model and asks for the search panel', async () => {
    const { fixture, actions } = await type('hello');
    expect(fixture.componentInstance.searchQuery()).toBe('hello');
    expect(actions).toEqual([{ type: 'search' }]);
  });

  it('does not ask again once the search panel is open', async () => {
    const { actions } = await type('hello', { surfaceKind: 'search' });
    expect(actions).toEqual([]);
  });

  it('shows a query set from outside', async () => {
    const { byId, fixture } = await build();
    fixture.componentRef.setInput('searchQuery', 'from panel');
    fixture.detectChanges();
    expect((byId('header-search') as HTMLInputElement).value).toBe(
      'from panel',
    );
  });

  it('focuses the field on focusSearch()', async () => {
    const { root, byId, fixture } = await build();
    document.body.append(root);
    fixture.componentInstance.focusSearch();
    expect(document.activeElement).toBe(byId('header-search'));
    root.remove();
  });

  it('clears and blurs the field on Escape, without letting the key reach the page', async () => {
    const { root, field, fixture } = await type('hello');
    document.body.append(root);
    field.focus();
    let reachedDocument = false;
    document.addEventListener('keydown', () => (reachedDocument = true), {
      once: true,
    });
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.searchQuery()).toBe('');
    expect(document.activeElement).not.toBe(field);
    expect(reachedDocument).toBe(false);
    root.remove();
  });

  it('lets Escape in an empty field bubble to the page', async () => {
    const { root, field } = await type('');
    document.body.append(root);
    let reachedDocument = false;
    document.addEventListener('keydown', () => (reachedDocument = true), {
      once: true,
    });
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(reachedDocument).toBe(true);
    root.remove();
  });
});

describe('RoomHeaderComponent for a linked room the client does not hold yet', () => {
  const roomActions = [
    'search-messages',
    'open-threads',
    'open-pinned',
    'toggle-members',
    'room-actions-overflow',
  ];

  it('titles the header "Loading room…" and offers no room-scoped actions', async () => {
    const { root, byId } = await build({ room: null, loading: true });
    expect(root.querySelector('h1')?.textContent).toContain('Loading room…');
    for (const id of roomActions) expect(byId(id), id).toBeNull();
  });

  it('drops the loading title once the room is known to be unavailable', async () => {
    const { root } = await build({ room: null, loading: false });
    expect(root.querySelector('h1')?.textContent).not.toContain(
      'Loading room…',
    );
  });
});
