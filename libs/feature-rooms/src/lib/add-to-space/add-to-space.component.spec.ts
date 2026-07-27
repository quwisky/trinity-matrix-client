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
import { AddToSpaceComponent } from './add-to-space.component';

function room(id: string, name: string) {
  return { id, name, initial: name[0], avatarMxc: null } as never;
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
  over: { addExistingRoom?: ReturnType<typeof vi.fn> } = {},
) {
  const addExistingRoom = over.addExistingRoom ?? vi.fn(() => of(undefined));
  const close = vi.fn();
  const toastShow = vi.fn();
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
        childLinks: () =>
          (opts.existing ?? []).map((childId) => ({
            childId,
            via: ['hs'],
            suggested: false,
            order: '',
          })),
      }),
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
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

  it('offers other spaces, so an existing space can be nested', async () => {
    const { cmp } = await build({
      rooms: [room('!a:hs', 'Alpha')],
      spaces: [space('!sub:hs', 'Subspace')],
    });

    const nested = cmp.candidates().find((c) => c.id === '!sub:hs');
    expect(nested?.isSpace).toBe(true);
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

    cmp.query.setValue('design');

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
