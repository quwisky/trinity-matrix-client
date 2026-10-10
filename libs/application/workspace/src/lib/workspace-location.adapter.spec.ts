import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import {
  DefaultUrlSerializer,
  NavigationEnd,
  Router,
  type UrlTree,
} from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';
import { workspaceUrlOf } from './workspace-url';

const ALICE = '@alice:example.org';

const ROOM = '!room:example.org';

function setup(initialUrl: string) {
  let url = initialUrl;
  let state: unknown = null;
  const events = new Subject<NavigationEnd>();
  const serializer = new DefaultUrlSerializer();
  const navigate = vi.fn(() => Promise.resolve(true));
  const location = {
    getState: () => state,
    replaceState: vi.fn((next: string) => {
      url = next;
    }),
    back: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      WorkspaceLocationAdapter,
      { provide: Location, useValue: location },
      {
        provide: Router,
        useValue: {
          get url() {
            return url;
          },
          events,
          navigate,
          parseUrl: (value: string) => serializer.parse(value),
          createUrlTree: (
            commands: readonly string[],
            extras: { readonly queryParams?: Record<string, string> },
          ): UrlTree =>
            serializer.parse(
              `${commands.join('/')}?${new URLSearchParams(extras.queryParams ?? {})}`,
            ),
          serializeUrl: (tree: UrlTree) => serializer.serialize(tree),
        },
      },
    ],
  });
  return {
    adapter: TestBed.inject(WorkspaceLocationAdapter),
    navigate,
    location,
    url: () => url,
    moveTo(next: string, nextState: unknown = null) {
      url = next;
      state = nextState;
      events.next(new NavigationEnd(1, next, next));
    },
  };
}

const conversation = {
  accountId: ALICE,
  scope: { kind: 'recent' },
  roomId: ROOM,
  pane: 'conversation',
} as const;

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceLocationAdapter', () => {
  it('parses Workspace coordinates and distinguishes other routes', () => {
    const test = setup(`/rooms?account=${encodeURIComponent(ALICE)}`);

    expect(test.adapter.current(null)).toMatchObject({
      kind: 'workspace',
      parsed: {
        destination: { accountId: ALICE, roomId: null, pane: 'list' },
        canonical: true,
      },
    });
    test.moveTo('/settings');
    expect(test.adapter.current(ALICE)).toEqual({ kind: 'outside' });
  });

  it('observes the current location immediately and after navigation', () => {
    const test = setup('/settings');
    const seen: string[] = [];
    const subscription = test.adapter
      .changes(() => ALICE)
      .subscribe((location) => seen.push(location.kind));

    test.moveTo(`/rooms?account=${encodeURIComponent(ALICE)}`);

    expect(seen).toEqual(['outside', 'workspace']);
    subscription.unsubscribe();
  });

  it('keeps projection cold and hides Router commands behind the adapter', async () => {
    const test = setup('/settings');
    const command = test.adapter.project(
      {
        accountId: ALICE,
        scope: { kind: 'recent' },
        roomId: null,
        pane: 'list',
      },
      { history: 'replace' },
    );

    expect(test.navigate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toBe(true);
    expect(test.navigate).toHaveBeenCalledWith(['/rooms'], {
      queryParams: { account: ALICE },
      replaceUrl: true,
    });
    expect(test.adapter.projecting).toBe(false);
  });

  it('rewrites the list it leaves and marks a Conversation pushed over it (#1113)', async () => {
    const test = setup(`/rooms?account=${encodeURIComponent(ALICE)}`);

    await firstValueFrom(
      test.adapter.project(conversation, { history: 'push', overList: true }),
    );

    // The entry below now names the list Back returns to, with this Room selected.
    expect(test.location.replaceState).toHaveBeenCalledOnce();
    expect(test.adapter.current(ALICE)).toMatchObject({
      kind: 'workspace',
      parsed: {
        destination: { accountId: ALICE, roomId: ROOM, pane: 'list' },
      },
    });
    expect(test.navigate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        replaceUrl: false,
        state: { trinityListBelow: true },
      }),
    );
  });

  it('leaves the entry below alone when the push does not start from the list', async () => {
    const test = setup('/settings');

    await firstValueFrom(
      test.adapter.project(conversation, { history: 'push', overList: true }),
    );

    expect(test.location.replaceState).not.toHaveBeenCalled();
    expect(test.navigate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.not.objectContaining({ state: expect.anything() }),
    );
  });

  it('pops back onto the list below without writing history', async () => {
    const test = setup('/rooms');
    const list = { ...conversation, pane: 'list' } as const;
    const settled = firstValueFrom(
      test.adapter.project(list, { history: 'back' }),
    );
    expect(test.adapter.projecting).toBe(true);
    expect(test.location.back).toHaveBeenCalledOnce();

    const router = TestBed.inject(Router);
    const projection = workspaceUrlOf(list);
    test.moveTo(
      router.serializeUrl(
        router.createUrlTree([...projection.commands], {
          queryParams: { ...projection.queryParams },
        }),
      ),
    );

    await expect(settled).resolves.toBe(true);
    expect(test.navigate).not.toHaveBeenCalled();
    expect(test.adapter.projecting).toBe(false);
  });

  it('writes the list in place when the pop lands somewhere else', async () => {
    const test = setup('/rooms');
    const list = { ...conversation, pane: 'list' } as const;
    const settled = firstValueFrom(
      test.adapter.project(list, { history: 'back' }),
    );
    test.moveTo('/settings');

    await expect(settled).resolves.toBe(true);
    expect(test.navigate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ replaceUrl: true }),
    );
  });

  it('follows the list-below mark of the current history entry', () => {
    const test = setup('/rooms');
    expect(test.adapter.listBelow()).toBe(false);
    test.moveTo('/rooms/x', { trinityListBelow: true });
    expect(test.adapter.listBelow()).toBe(true);
    test.moveTo('/rooms', { navigationId: 3 });
    expect(test.adapter.listBelow()).toBe(false);
  });
});
