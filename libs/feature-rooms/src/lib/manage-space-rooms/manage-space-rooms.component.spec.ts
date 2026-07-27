import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  RoomsService,
  SpaceChildrenService,
  SpacesService,
} from '@trinity/data-access-rooms';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ManageSpaceRoomsComponent } from './manage-space-rooms.component';

interface LinkFixture {
  childId: string;
  suggested?: boolean;
}

async function build(
  opts: {
    links?: LinkFixture[];
    rooms?: { id: string; name: string }[];
    openChildren?: { roomId: string; name: string }[];
  } = {},
  over: {
    setSuggested?: ReturnType<typeof vi.fn>;
    moveChildBefore?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const setSuggested = over.setSuggested ?? vi.fn(() => of(undefined));
  const moveChildBefore = over.moveChildBefore ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture, container } = await render(ManageSpaceRoomsComponent, {
    inputs: { spaceId: '!s:hs', spaceName: 'Design' },
    providers: [
      MockProvider(SpaceChildrenService, {
        setSuggested,
        moveChildBefore,
        childLinks: () =>
          (opts.links ?? []).map((link) => ({
            childId: link.childId,
            via: ['hs'],
            suggested: link.suggested ?? false,
            order: '',
          })),
      }),
      MockProvider(RoomsService, {
        rooms: signal(
          (opts.rooms ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            initial: r.name[0],
            avatarMxc: null,
          })),
        ) as never,
      }),
      MockProvider(SpacesService, {
        spaces: signal([]) as never,
        openSpaceChildren: signal(
          (opts.openChildren ?? []).map((c) => ({
            roomId: c.roomId,
            name: c.name,
            initial: c.name[0],
            avatarMxc: null,
          })),
        ) as never,
      }),
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    setSuggested,
    moveChildBefore,
    close,
    toastShow,
  };
}

describe('ManageSpaceRoomsComponent', () => {
  it('lists the space’s children in their curated order', async () => {
    const { cmp } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }],
      rooms: [
        { id: '!a:hs', name: 'Alpha' },
        { id: '!b:hs', name: 'Bravo' },
      ],
    });

    expect(cmp.childList().map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('names a child the viewer has not joined', async () => {
    // Only the hierarchy fetch knows this one — there is no local room to read a name
    // off — and falling back to a raw !id would make the list unusable.
    const { cmp } = await build({
      links: [{ childId: '!remote:hs' }],
      openChildren: [{ roomId: '!remote:hs', name: 'Not joined' }],
    });

    expect(cmp.childList()[0].name).toBe('Not joined');
  });

  it('falls back to the room id when nothing knows the name', async () => {
    const { cmp } = await build({ links: [{ childId: '!mystery:hs' }] });

    expect(cmp.childList()[0].name).toBe('!mystery:hs');
  });

  it('flags a child as suggested', async () => {
    const { cmp, setSuggested } = await build({
      links: [{ childId: '!a:hs' }],
    });

    cmp.toggleSuggested('!a:hs', true);

    expect(setSuggested).toHaveBeenCalledWith('!s:hs', '!a:hs', true);
  });

  it('unflags a suggested child', async () => {
    const { cmp, setSuggested } = await build({
      links: [{ childId: '!a:hs', suggested: true }],
    });

    cmp.toggleSuggested('!a:hs', false);

    expect(setSuggested).toHaveBeenCalledWith('!s:hs', '!a:hs', false);
  });

  it('moves a child up, above its current predecessor', async () => {
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }, { childId: '!c:hs' }],
    });

    cmp.move('!b:hs', 'up');

    expect(moveChildBefore).toHaveBeenCalledWith('!s:hs', '!b:hs', '!a:hs');
  });

  it('moves a child down, below its current successor', async () => {
    // Worth reading slowly, because the obvious expectation is wrong. Moving A down in
    // [A, B, C] yields [B, A, C], so A is re-inserted before *C* — the child after the
    // one it swapped with. Positions are resolved against the list WITHOUT the moving
    // child, which is what makes "before C" mean "after B".
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }, { childId: '!c:hs' }],
    });

    cmp.move('!a:hs', 'down');

    expect(moveChildBefore).toHaveBeenCalledWith('!s:hs', '!a:hs', '!c:hs');
  });

  it('moves the second-to-last child to the end', async () => {
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }],
    });

    cmp.move('!a:hs', 'down');

    // Nothing left to sit before — null means "append".
    expect(moveChildBefore).toHaveBeenCalledWith('!s:hs', '!a:hs', null);
  });

  it('does not move the first child up', async () => {
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }],
    });

    expect(cmp.isFirst('!a:hs')).toBe(true);
    cmp.move('!a:hs', 'up');

    expect(moveChildBefore).not.toHaveBeenCalled();
  });

  it('does not move the last child down', async () => {
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }, { childId: '!b:hs' }],
    });

    expect(cmp.isLast('!b:hs')).toBe(true);
    cmp.move('!b:hs', 'down');

    expect(moveChildBefore).not.toHaveBeenCalled();
  });

  it('ignores a move for a child that is not listed', async () => {
    const { cmp, moveChildBefore } = await build({
      links: [{ childId: '!a:hs' }],
    });

    cmp.move('!gone:hs', 'up');

    expect(moveChildBefore).not.toHaveBeenCalled();
  });

  it('reports a failed reorder instead of leaving the row stuck', async () => {
    const { cmp, toastShow } = await build(
      { links: [{ childId: '!a:hs' }, { childId: '!b:hs' }] },
      { moveChildBefore: vi.fn(() => throwError(() => new Error('nope'))) },
    );

    cmp.move('!b:hs', 'up');

    expect(cmp.busyChildId()).toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('reports a failed suggestion toggle', async () => {
    const { cmp, toastShow } = await build(
      { links: [{ childId: '!a:hs' }] },
      { setSuggested: vi.fn(() => throwError(() => new Error('nope'))) },
    );

    cmp.toggleSuggested('!a:hs', true);

    expect(cmp.busyChildId()).toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('clears the busy row after a successful write', async () => {
    const { cmp } = await build({ links: [{ childId: '!a:hs' }] });

    cmp.toggleSuggested('!a:hs', true);

    expect(cmp.busyChildId()).toBeNull();
  });
});
