import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { EMPTY, of, throwError, Subject } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  PublicRoomsService,
  type PublicRoomsPage,
  type PublicRoomSummary,
} from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/components/avatar';
import { ConnectionError, MatrixError } from '@trinity/util/matrix';
import { RoomDirectoryComponent } from './room-directory.component';

function room(over: Partial<PublicRoomSummary> = {}): PublicRoomSummary {
  return {
    roomId: '!r:hs',
    name: 'General',
    topic: null,
    alias: '#general:hs',
    avatarMxc: null,
    memberCount: 3,
    isSpace: false,
    ...over,
  };
}

function page(over: Partial<PublicRoomsPage> = {}): PublicRoomsPage {
  return { rooms: [room()], nextBatch: null, total: 1, ...over };
}

async function build(
  over: {
    search?: Mock;
    join?: Mock;
  } = {},
) {
  const search = over.search ?? vi.fn(() => of(page()));
  const join = over.join ?? vi.fn(() => of('!joined:hs'));
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture, container } = await render(RoomDirectoryComponent, {
    imports: [MockComponent(AvatarComponent)],
    providers: [
      MockProvider(PublicRoomsService, { search, join }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    search,
    join,
    close,
    toastShow,
  };
}

describe('RoomDirectoryComponent', () => {
  it('loads the first page of public rooms on open', async () => {
    const { cmp, search, container } = await build();
    expect(search).toHaveBeenCalledWith({
      term: '',
      since: undefined,
      spaces: false,
    });
    expect(cmp.rooms()).toHaveLength(1);
    expect(container.textContent).toContain('General');
  });

  it('searches by the entered term', async () => {
    const { cmp, search } = await build();
    cmp.searchForm.query().value.set('chess');

    cmp.search();

    expect(search).toHaveBeenLastCalledWith({
      term: 'chess',
      since: undefined,
      spaces: false,
    });
  });

  // Dispatched on the real <form> rather than by calling a handler: preventDefault is
  // the [formRoot] directive's job now, so a test that called a component method would
  // pass with the binding removed — which is exactly the regression it guards against.
  it('runs the search and prevents the native form navigation on submit', async () => {
    const { container, search } = await build();
    const form = container.querySelector('form');
    const event = new Event('submit', { cancelable: true, bubbles: true });

    form?.dispatchEvent(event);

    expect(form).not.toBeNull();
    expect(event.defaultPrevented).toBe(true); // no page reload
    expect(search).toHaveBeenCalledTimes(2); // ngOnInit + submit
  });

  it('switches to Spaces mode and re-runs the search restricted to spaces', async () => {
    const { cmp, search } = await build();

    cmp.setMode('spaces');

    expect(cmp.mode()).toBe('spaces');
    expect(search).toHaveBeenLastCalledWith({
      term: '',
      since: undefined,
      spaces: true,
    });
  });

  it('switching mode supersedes an in-flight search (no dropped results)', async () => {
    // First (ngOnInit) search never completes; switching to Spaces must still run.
    const roomsPage$ = new Subject<PublicRoomsPage>();
    const search = vi
      .fn()
      .mockReturnValueOnce(roomsPage$)
      .mockReturnValueOnce(
        of(page({ rooms: [room({ roomId: '!space:hs' })] })),
      );
    const { cmp } = await build({ search });

    cmp.setMode('spaces'); // while the initial request is still pending

    expect(search).toHaveBeenLastCalledWith({
      term: '',
      since: undefined,
      spaces: true,
    });
    expect(cmp.rooms().map((r) => r.roomId)).toEqual(['!space:hs']);
    expect(cmp.loading()).toBe(false);
  });

  it('ignores selecting the mode already active', async () => {
    const { cmp, search } = await build();
    const calls = search.mock.calls.length;

    cmp.setMode('rooms');

    expect(search.mock.calls.length).toBe(calls); // no extra query
  });

  it('appends the next page and threads the pagination token on load more', async () => {
    const search = vi
      .fn()
      .mockReturnValueOnce(
        of(page({ rooms: [room({ roomId: '!a:hs' })], nextBatch: 'tok' })),
      )
      .mockReturnValueOnce(
        of(page({ rooms: [room({ roomId: '!b:hs' })], nextBatch: null })),
      );
    const { cmp } = await build({ search });
    expect(cmp.hasMore()).toBe(true);

    cmp.loadMore();

    expect(search).toHaveBeenLastCalledWith({
      term: '',
      since: 'tok',
      spaces: false,
    });
    expect(cmp.rooms().map((r) => r.roomId)).toEqual(['!a:hs', '!b:hs']);
    expect(cmp.hasMore()).toBe(false);
  });

  it('shows the empty state when no rooms match', async () => {
    const search = vi.fn(() => of(page({ rooms: [], nextBatch: null })));
    const { container } = await build({ search });
    expect(
      container.querySelector('[data-testid=directory-empty]'),
    ).not.toBeNull();
  });

  it('joins a room by its alias and closes resolving the joined id', async () => {
    const { cmp, join, close } = await build();

    cmp.join(room({ roomId: '!r:hs', alias: '#general:hs' }));

    expect(join).toHaveBeenCalledWith('#general:hs'); // alias preferred
    expect(close).toHaveBeenCalledWith({
      roomId: '!joined:hs',
      isSpace: false,
    });
  });

  it('flags the joined entry as a space when closing', async () => {
    const { cmp, close } = await build();

    cmp.join(room({ alias: null, isSpace: true }));

    expect(close).toHaveBeenCalledWith({ roomId: '!joined:hs', isSpace: true });
  });

  it('joins by room id when there is no alias', async () => {
    const { cmp, join } = await build();

    cmp.join(room({ roomId: '!x:hs', alias: null }));

    expect(join).toHaveBeenCalledWith('!x:hs');
  });

  it('keeps the dialog open and toasts when a join fails', async () => {
    const join = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, close, toastShow } = await build({ join });

    cmp.join(room({ name: 'General' }));

    expect(close).not.toHaveBeenCalled();
    expect(cmp.joining()).toBeNull(); // cleared for a retry
    expect(toastShow).toHaveBeenCalledWith(
      'nope',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('releases a failed HTTP join and shows actionable retry guidance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const join = vi.fn(() =>
      throwError(
        () =>
          new MatrixError(
            { errcode: 'M_UNKNOWN', error: 'upstream unavailable' },
            503,
          ),
      ),
    );
    const { cmp, toastShow } = await build({ join });

    cmp.join(room({ name: 'General' }));

    expect(cmp.joining()).toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      'The homeserver is unavailable. Try again.',
      expect.objectContaining({ variant: 'destructive' }),
    );
    warn.mockRestore();
  });

  it('releases a join that completes without a result', async () => {
    const join = vi.fn(() => EMPTY);
    const { cmp } = await build({ join });

    cmp.join(room());

    expect(cmp.joining()).toBeNull();
  });

  it('surfaces a directory load failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = vi.fn(() => throwError(() => new Error('down')));
    const { cmp } = await build({ search });
    expect(cmp.error()).toBe('Could not load the room directory.');
    expect(warn).toHaveBeenCalledWith(
      '[trinity] Matrix request failed',
      expect.objectContaining({ operation: 'load room directory' }),
    );
    warn.mockRestore();
  });

  it('turns a connection failure into actionable retry guidance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = vi.fn(() =>
      throwError(() => new ConnectionError('fetch failed')),
    );
    const { cmp } = await build({ search });

    expect(cmp.error()).toBe('Check your connection and try again.');
    expect(cmp.loading()).toBe(false);
    warn.mockRestore();
  });

  it('releases loading after an empty response and allows a retry', async () => {
    const search = vi
      .fn()
      .mockReturnValueOnce(EMPTY)
      .mockReturnValueOnce(of(page()));
    const { cmp } = await build({ search });

    expect(cmp.loading()).toBe(false);

    cmp.search();

    expect(search).toHaveBeenCalledTimes(2);
    expect(cmp.rooms()).toEqual([room()]);
  });

  it('closes resolving null when dismissed', async () => {
    const { cmp } = await build();
    cmp.close();
    expect(TestBed.inject(TrnDialogRef).close).toHaveBeenCalledWith(null);
  });
});
