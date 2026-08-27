import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  RoomsService,
  SpaceChildrenService,
  SpacesService,
} from '@trinity/data-access/rooms';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { AddToSpaceComponent } from './add-to-space.component';

function room(id: string, name: string, directUserId?: string) {
  return {
    id,
    name,
    initial: name[0],
    avatarMxc: null,
    ...(directUserId ? { directUserId } : {}),
  } as never;
}

function space(id: string, name: string) {
  return { id, name, initial: name[0], avatarMxc: null } as never;
}

async function build(
  opts: {
    rooms?: ReturnType<typeof room>[];
    spaces?: ReturnType<typeof space>[];
    existing?: string[];
  } = {},
  over: { addExistingRoom?: Mock } = {},
) {
  const addExistingRoom = over.addExistingRoom ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
  const links = signal(
    (opts.existing ?? []).map((childId) => ({
      childId,
      via: ['hs'],
      suggested: false,
      order: '',
    })),
  );
  const { fixture, container } = await render(AddToSpaceComponent, {
    inputs: { spaceId: '!s:hs', spaceName: 'Design' },
    providers: [
      MockProvider(RoomsService, {
        rooms: signal(opts.rooms ?? []) as never,
      }),
      MockProvider(SpacesService, {
        spaces: signal(opts.spaces ?? []) as never,
      }),
      MockProvider(SpaceChildrenService, {
        addExistingRoom,
        // ONE signal, created here and handed back on every call — not a fresh one per
        // call, which would be a dependency no test could move and would let a staleness
        // regression pass forever. `linksFor` memoizes per space id for the same reason.
        linksFor: () => links.asReadonly(),
      }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    links,
    addExistingRoom,
    close,
    toastShow,
  };
}

describe('AddToSpaceComponent', () => {
  it('offers the rooms the user is in', async () => {
    const { cmp } = await build({
      rooms: [room('!a:hs', 'Alpha'), room('!b:hs', 'Bravo')],
    });

    expect(cmp.candidates().map((c) => c.id)).toEqual(['!a:hs', '!b:hs']);
  });

  it('hides rooms already in the space', async () => {
    // The whole point of the dialog is what is NOT yet here; listing a current child
    // invites a write that would reset its curation.
    const { cmp } = await build({
      rooms: [room('!a:hs', 'Alpha'), room('!b:hs', 'Bravo')],
      existing: ['!a:hs'],
    });

    expect(cmp.candidates().map((c) => c.id)).toEqual(['!b:hs']);
  });

  it('drops a room from the list as soon as its link echoes back', async () => {
    // The dialog's docblock promises a room added here disappears "as soon as the write
    // echoes back, without a round trip". That is only true if the candidate list depends
    // on the links REACTIVELY — a plain snapshot read looks identical until sync moves
    // something else. Driving the projection is the only way to tell the two apart.
    const { cmp, links } = await build({
      rooms: [room('!a:hs', 'Alpha'), room('!b:hs', 'Bravo')],
    });
    expect(cmp.candidates().map((c) => c.id)).toEqual(['!a:hs', '!b:hs']);

    links.set([{ childId: '!a:hs', via: ['hs'], suggested: false, order: '' }]);

    expect(cmp.candidates().map((c) => c.id)).toEqual(['!b:hs']);
  });

  it('offers other spaces, so an existing space can be nested', async () => {
    const { cmp } = await build({
      rooms: [room('!a:hs', 'Alpha')],
      spaces: [space('!sub:hs', 'Subspace')],
    });

    const nested = cmp.candidates().find((c) => c.id === '!sub:hs');
    expect(nested?.isSpace).toBe(true);
  });

  it('keeps DMs circular while rooms and spaces are place-shaped', async () => {
    const { cmp, container } = await build({
      rooms: [
        room('!dm:hs', 'Alice', '@alice:hs'),
        room('!room:hs', 'General'),
      ],
      spaces: [space('!sub:hs', 'Workspace')],
    });

    expect(
      new Map(
        cmp.candidates().map((candidate) => [candidate.name, candidate.shape]),
      ),
    ).toEqual(
      new Map([
        ['Alice', 'person'],
        ['General', 'place'],
        ['Workspace', 'place'],
      ]),
    );
    expect(
      [...container.querySelectorAll('trn-avatar')].map((avatar) =>
        avatar.getAttribute('data-shape'),
      ),
    ).toEqual(['person', 'place', 'place']);
  });

  it('never offers the space to itself', async () => {
    // A space containing itself is a link the server would accept and no client could
    // render sensibly.
    const { cmp } = await build({
      spaces: [space('!s:hs', 'Design'), space('!other:hs', 'Other')],
    });

    expect(cmp.candidates().map((c) => c.id)).toEqual(['!other:hs']);
  });

  it('filters the list by the search term', async () => {
    const { cmp } = await build({
      rooms: [room('!a:hs', 'Design chat'), room('!b:hs', 'Random')],
    });

    cmp.search.query().value.set('design');

    expect(cmp.visible().map((c) => c.id)).toEqual(['!a:hs']);
  });

  it('adds only the rooms that were ticked', async () => {
    const { cmp, addExistingRoom, close } = await build({
      rooms: [room('!a:hs', 'Alpha'), room('!b:hs', 'Bravo')],
    });
    cmp.toggle('!b:hs', true);

    cmp.add();

    expect(addExistingRoom).toHaveBeenCalledTimes(1);
    expect(addExistingRoom).toHaveBeenCalledWith('!s:hs', '!b:hs');
    expect(close).toHaveBeenCalledWith(true);
  });

  it('adds several rooms in one go', async () => {
    const { cmp, addExistingRoom } = await build({
      rooms: [room('!a:hs', 'Alpha'), room('!b:hs', 'Bravo')],
    });
    cmp.toggle('!a:hs', true);
    cmp.toggle('!b:hs', true);

    cmp.add();

    expect(addExistingRoom).toHaveBeenCalledTimes(2);
  });

  it('unticking removes a room from the batch', async () => {
    const { cmp, addExistingRoom, close } = await build({
      rooms: [room('!a:hs', 'Alpha')],
    });
    cmp.toggle('!a:hs', true);
    cmp.toggle('!a:hs', false);

    cmp.add();

    expect(addExistingRoom).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('names the rooms that failed without claiming they were added', async () => {
    // Each link is its own state event, so a partial failure is normal — and saying
    // "added" for a room that was rejected is the one thing this must not do.
    const { cmp, close, toastShow } = await build(
      { rooms: [room('!a:hs', 'Alpha')] },
      {
        addExistingRoom: vi.fn(() => throwError(() => new Error('forbidden'))),
      },
    );
    cmp.toggle('!a:hs', true);

    cmp.add();

    expect(close).not.toHaveBeenCalled();
    expect(cmp.adding()).toBe(false);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Alpha'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('closes without writing on cancel', async () => {
    const { cmp, addExistingRoom, close } = await build({
      rooms: [room('!a:hs', 'Alpha')],
    });

    cmp.close();

    expect(addExistingRoom).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });
});
