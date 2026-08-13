import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  RoomsService,
  SpaceChildrenService,
  SpacesService,
} from '@trinity/data-access/rooms';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { ManageSpaceRoomsComponent } from './manage-space-rooms.component';

interface LinkFixture {
  childId: string;
  suggested?: boolean;
  order?: string;
}

async function build(
  opts: {
    links?: LinkFixture[];
    rooms?: { id: string; name: string }[];
    openChildren?: { roomId: string; name: string }[];
  } = {},
  over: {
    setSuggested?: Mock;
    moveChildBefore?: Mock;
  } = {},
) {
  const setSuggested = over.setSuggested ?? vi.fn(() => of(undefined));
  const moveChildBefore = over.moveChildBefore ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  /**
   * The links the service is projecting, as a signal a test can DRIVE.
   *
   * This was a closure returning a fresh array from a fixture, which no test could change
   * — so the component's staleness was structurally invisible here. Anything asserting
   * that the list follows the server needs to be able to move the server.
   */
  const links = signal<
    { childId: string; via: string[]; suggested: boolean; order: string }[]
  >(
    (opts.links ?? []).map((link) => ({
      childId: link.childId,
      via: ['hs'],
      suggested: link.suggested ?? false,
      order: link.order ?? '',
    })),
  );
  const { fixture, container } = await render(ManageSpaceRoomsComponent, {
    inputs: { spaceId: '!s:hs', spaceName: 'Design' },
    providers: [
      MockProvider(SpaceChildrenService, {
        setSuggested,
        moveChildBefore,
        linksFor: () => links.asReadonly(),
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
    fixture,
    links,
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

  it('follows the projected links without a write of its own', async () => {
    // The change arriving from sync — another device, another admin, or this device's own
    // write echoing back. Before the counter came out, the only thing that re-read the
    // list was this component's own write callback.
    const { cmp, links } = await build({
      links: [{ childId: '!a:hs' }],
      rooms: [
        { id: '!a:hs', name: 'Alpha' },
        { id: '!b:hs', name: 'Bravo' },
      ],
    });

    links.update((current) => [
      ...current,
      { childId: '!b:hs', via: ['hs'], suggested: false, order: '' },
    ]);

    expect(cmp.childList().map((child) => child.name)).toEqual([
      'Alpha',
      'Bravo',
    ]);
  });

  describe('two curation writes in a row', () => {
    /**
     * Every curation write is a read-modify-write against live room state, and
     * `sendStateEvent` is a bare PUT with no local echo — so a second write issued before
     * the first one's echo reads the PRE-write link and re-sends it. Suggesting a room and
     * immediately moving it therefore un-suggested it, silently, because `writeLink` omits
     * `suggested` when falsy. The window is real because `busyChildId` cleared when the PUT
     * resolved, a round trip before the state it read caught up.
     */
    it('refuses a second write while the first is still in flight', async () => {
      const accepted = new Subject<void>();
      const { cmp, moveChildBefore } = await build(
        { links: [{ childId: '!a:hs' }, { childId: '!b:hs' }] },
        { setSuggested: vi.fn(() => accepted) },
      );

      cmp.toggleSuggested('!a:hs', true);
      cmp.move('!a:hs', 'down');

      expect(moveChildBefore).not.toHaveBeenCalled();
    });

    it('still refuses once the server has answered but the echo has not landed', async () => {
      const accepted = new Subject<void>();
      const { cmp, moveChildBefore } = await build(
        { links: [{ childId: '!a:hs' }, { childId: '!b:hs' }] },
        { setSuggested: vi.fn(() => accepted) },
      );

      cmp.toggleSuggested('!a:hs', true);
      // The PUT resolved. The room state the next write would read is still pre-write.
      accepted.next();
      accepted.complete();

      cmp.move('!a:hs', 'down');

      expect(moveChildBefore).not.toHaveBeenCalled();
    });

    it('allows the next write once the echo has been projected', async () => {
      const accepted = new Subject<void>();
      const { cmp, fixture, links, moveChildBefore } = await build(
        { links: [{ childId: '!a:hs' }, { childId: '!b:hs' }] },
        { setSuggested: vi.fn(() => accepted) },
      );

      cmp.toggleSuggested('!a:hs', true);
      accepted.next();
      accepted.complete();
      // The echo arrives: the projection now carries what was written.
      links.update((current) =>
        current.map((link) =>
          link.childId === '!a:hs' ? { ...link, suggested: true } : link,
        ),
      );
      await fixture.whenStable();

      cmp.move('!a:hs', 'down');

      expect(moveChildBefore).toHaveBeenCalledWith('!s:hs', '!a:hs', null);
    });

    it('releases the lock when the write is refused', async () => {
      const { cmp, moveChildBefore } = await build(
        { links: [{ childId: '!a:hs' }, { childId: '!b:hs' }] },
        { setSuggested: vi.fn(() => throwError(() => new Error('nope'))) },
      );

      cmp.toggleSuggested('!a:hs', true);
      cmp.move('!a:hs', 'down');

      expect(moveChildBefore).toHaveBeenCalledWith('!s:hs', '!a:hs', null);
    });
  });

  describe('the order the rows are arranged in', () => {
    /**
     * The service sorts by (order, child id) because it reads `m.space.child` alone and a
     * child the viewer has not joined has no local room to take a name from. The sidebar
     * tiebreaks on name. Both lists describe the same space, so an admin arranging it here
     * must see the arrangement everyone else reads — hence the tiebreak is applied where
     * the names exist, which is here.
     */
    it('tiebreaks on name, not on the child id the service sorted by', async () => {
      const { cmp } = await build({
        links: [{ childId: '!aaa:hs' }, { childId: '!zzz:hs' }],
        rooms: [
          { id: '!aaa:hs', name: 'Zulu' },
          { id: '!zzz:hs', name: 'Alpha' },
        ],
      });

      expect(cmp.childList().map((child) => child.name)).toEqual([
        'Alpha',
        'Zulu',
      ]);
    });

    it('still lets an explicit order key win over the name', async () => {
      const { cmp } = await build({
        links: [
          { childId: '!aaa:hs', order: 'm' },
          { childId: '!zzz:hs', order: 'a' },
        ],
        rooms: [
          { id: '!aaa:hs', name: 'Alpha' },
          { id: '!zzz:hs', name: 'Zulu' },
        ],
      });

      expect(cmp.childList().map((child) => child.name)).toEqual([
        'Zulu',
        'Alpha',
      ]);
    });

    it('puts a child with no order key after the ones that have one', async () => {
      const { cmp } = await build({
        links: [{ childId: '!aaa:hs' }, { childId: '!zzz:hs', order: 'm' }],
        rooms: [
          { id: '!aaa:hs', name: 'Alpha' },
          { id: '!zzz:hs', name: 'Zulu' },
        ],
      });

      expect(cmp.childList().map((child) => child.name)).toEqual([
        'Zulu',
        'Alpha',
      ]);
    });

    it('orders by code point, so an uppercase key precedes a lowercase one', async () => {
      const { cmp } = await build({
        links: [
          { childId: '!aaa:hs', order: 'a' },
          { childId: '!zzz:hs', order: 'B' },
        ],
        rooms: [
          { id: '!aaa:hs', name: 'Alpha' },
          { id: '!zzz:hs', name: 'Zulu' },
        ],
      });

      expect(cmp.childList().map((child) => child.name)).toEqual([
        'Zulu',
        'Alpha',
      ]);
    });
  });

  describe('a rejected suggested write', () => {
    it('puts the row back the way the server has it', async () => {
      // The checkbox ticks itself on click and only re-derives when its `checked` INPUT
      // changes value. Leaving the row at the server's `false` is no change at all, so
      // without the rollback the box stays ticked for a write that was refused.
      const { cmp } = await build(
        { links: [{ childId: '!a:hs', suggested: false }] },
        { setSuggested: vi.fn(() => throwError(() => new Error('nope'))) },
      );

      cmp.toggleSuggested('!a:hs', true);

      expect(cmp.childList()[0].suggested).toBe(false);
    });

    it('shows the change while the write is in flight', async () => {
      // The other half: an overlay that never showed anything would "pass" the test above
      // by doing nothing at all.
      const pending = new Subject<void>();
      const { cmp } = await build(
        { links: [{ childId: '!a:hs', suggested: false }] },
        { setSuggested: vi.fn(() => pending.asObservable()) },
      );

      cmp.toggleSuggested('!a:hs', true);

      expect(cmp.childList()[0].suggested).toBe(true);
    });

    it('un-ticks the rendered checkbox, not just the row model', async () => {
      // At the DOM, because that is where the bug is. `HlmCheckbox.checked` is a
      // linkedSignal the click handler sets locally, so the row model going back to false
      // is necessary but not sufficient — the INPUT has to transition for the checkbox to
      // re-derive. Asserting `childList()[0].suggested` alone passes while the box stays
      // ticked next to the failure toast.
      // The rejection is delivered AFTER a render, which is what a server refusal is: the
      // write goes out, the UI paints the optimistic tick, and the homeserver says no a
      // round trip later. That gap is load-bearing — see the note on `pendingSuggested`.
      const rejection = new Subject<void>();
      const { container, fixture } = await build(
        { links: [{ childId: '!a:hs', suggested: false }] },
        { setSuggested: vi.fn(() => rejection.asObservable()) },
      );
      const box = container.querySelector(
        '[data-testid="suggest-!a:hs"] [role="checkbox"]',
      ) as HTMLElement;

      box.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(box.getAttribute('aria-checked')).toBe('true');

      rejection.error(new Error('nope'));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(box.getAttribute('aria-checked')).toBe('false');
    });

    it('yields to the projection when the echo carries a different value', async () => {
      // Reachable without a second device: toggle a room suggested, then immediately move
      // it. The reorder is a read-modify-write against state that still holds the pre-write
      // link, so it re-sends without `suggested` and the server reverts the tick — and both
      // state events coalesce into one rebuild, so the value we wrote is never projected.
      // An overlay that waited to SEE its own value would beat the projection indefinitely.
      const { cmp, links, fixture } = await build(
        { links: [{ childId: '!a:hs', suggested: false }] },
        { setSuggested: vi.fn(() => of(undefined)) },
      );

      cmp.toggleSuggested('!a:hs', true);
      expect(cmp.childList()[0].suggested).toBe(true);

      // The echo, carrying the server's actual answer rather than ours.
      links.set([
        { childId: '!a:hs', via: ['hs'], suggested: false, order: '' },
      ]);
      await fixture.whenStable();
      fixture.detectChanges();

      expect(cmp.childList()[0].suggested).toBe(false);
    });

    it('keeps a successful change on screen until the echo lands', async () => {
      // Clearing the overlay when the write RESOLVES would drive the checkbox
      // true→false→true: the server has taken it, but the state echo is a sync away.
      const { cmp, links } = await build(
        { links: [{ childId: '!a:hs', suggested: false }] },
        { setSuggested: vi.fn(() => of(undefined)) },
      );

      cmp.toggleSuggested('!a:hs', true);
      expect(cmp.childList()[0].suggested).toBe(true);

      links.set([
        { childId: '!a:hs', via: ['hs'], suggested: true, order: '' },
      ]);

      expect(cmp.childList()[0].suggested).toBe(true);
    });
  });
});
