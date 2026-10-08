import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  SpacesService,
  type SpaceChildRoom,
} from '@trinity/data-access/room-library';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { SpaceChildrenListComponent } from './space-children-list.component';

function child(over: Partial<SpaceChildRoom> = {}): SpaceChildRoom {
  return {
    accountId: '@me:hs',
    roomId: '!c:hs',
    name: 'announcements',
    initial: 'A',
    avatarMxc: null,
    memberCount: 4,
    joinRule: 'public',
    suggested: false,
    isSpace: false,
    via: ['hs.example'],
    joined: false,
    ...over,
  };
}

async function renderList(
  opts: {
    rooms?: SpaceChildRoom[];
    spaces?: SpaceChildRoom[];
    loading?: boolean;
    error?: string | null;
    filter?: string;
  } = {},
) {
  const rendered = await render(SpaceChildrenListComponent, {
    inputs: { filter: opts.filter ?? '' },
    providers: [
      provideTrnIcons(),
      MockProvider(SpacesService, {
        notJoinedRooms: signal(opts.rooms ?? []),
        childSpaces: signal(opts.spaces ?? []),
        childrenLoading: signal(opts.loading ?? false),
        childrenError: signal(opts.error ?? null),
      }),
    ],
  });
  const joined: SpaceChildRoom[] = [];
  const opened: unknown[] = [];
  rendered.fixture.componentInstance.join.subscribe((c) => joined.push(c));
  rendered.fixture.componentInstance.open.subscribe((c) => opened.push(c));
  return { ...rendered, joined, opened };
}

describe('SpaceChildrenListComponent', () => {
  it('shows only the loading line while the hierarchy loads', async () => {
    const { container } = await renderList({
      loading: true,
      rooms: [child()],
    });

    expect(container.textContent).toContain('Loading rooms');
    expect(container.querySelector('.joinable')).toBeNull();
  });

  it('shows the failure line when the hierarchy fails', async () => {
    const { container } = await renderList({ error: 'nope' });

    expect(container.textContent).toContain(
      'Couldn’t load this space’s rooms.',
    );
  });

  it('lists joinable rooms and emits join', async () => {
    const { container, joined } = await renderList({
      rooms: [child({ roomId: '!r:hs', name: 'random', suggested: true })],
    });

    expect(container.querySelector('.category')?.textContent).toContain(
      'More rooms',
    );
    expect(container.querySelector('.joinable__tag')?.textContent).toContain(
      'Suggested',
    );
    container
      .querySelector<HTMLElement>('[data-testid="join-child-!r:hs"]')!
      .click();
    expect(joined.map((c) => c.roomId)).toEqual(['!r:hs']);
  });

  it('opens a joined sub-space and joins an unjoined one', async () => {
    const { container, joined, opened } = await renderList({
      spaces: [
        child({ roomId: '!s1:hs', name: 'Alpha', isSpace: true, joined: true }),
        child({ roomId: '!s2:hs', name: 'Beta', isSpace: true }),
      ],
    });

    container.querySelector<HTMLElement>('[aria-label="Open Alpha"]')!.click();
    container.querySelector<HTMLElement>('[aria-label="Join Beta"]')!.click();

    expect(opened).toEqual([{ spaceId: '!s1:hs', accountId: '@me:hs' }]);
    expect(joined.map((c) => c.roomId)).toEqual(['!s2:hs']);
  });

  it('narrows both lists by the normalised filter', async () => {
    const { container } = await renderList({
      filter: 'rand',
      rooms: [
        child({ name: 'random' }),
        child({ roomId: '!x', name: 'other' }),
      ],
      spaces: [child({ roomId: '!s', name: 'Gamma', isSpace: true })],
    });

    expect(container.querySelectorAll('.joinable')).toHaveLength(1);
    expect(container.textContent).not.toContain('Spaces');
  });
});
