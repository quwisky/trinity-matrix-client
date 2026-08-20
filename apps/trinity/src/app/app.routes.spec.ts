import { Component, type OnDestroy } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlSegment,
  provideRouter,
  type Routes,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { authGuard } from '@trinity/data-access/auth';
import { describe, expect, it } from 'vitest';

import { routes } from './app.routes';

/** Stands in for every routed page: this spec is about matching, not rendering. */
@Component({ template: '' })
class BlankComponent {}

/**
 * The real table with its lazy loaders and guards stripped. What is under test is the
 * PATH structure — whether an unknown URL matches anything at all — and resolving the
 * real `loadComponent` chunks would drag every feature lib (and its SDK dependencies)
 * into this run. Paths, MATCHERS, redirects and `pathMatch` are copied verbatim, so deleting
 * the wildcard from app.routes.ts still fails these tests.
 *
 * The matcher branch is not optional: `/rooms` is matched by a function rather than a path (one
 * Route object for both `/rooms` and `/rooms/<segment>`, so the page instance is reused across
 * them). Rebuilding it as `{ path: undefined }` makes the router reject the whole table with
 * NG04014, which is how this stopped compiling the first time.
 */
const pathTable: Routes = routes.map((route) =>
  route.redirectTo === undefined
    ? route.matcher
      ? { matcher: route.matcher, component: BlankComponent }
      : { path: route.path, component: BlankComponent }
    : {
        path: route.path,
        redirectTo: route.redirectTo,
        ...(route.pathMatch ? { pathMatch: route.pathMatch } : {}),
      },
);

async function navigate(url: string): Promise<Router> {
  TestBed.configureTestingModule({ providers: [provideRouter(pathTable)] });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  return router;
}

describe('app routes', () => {
  // The service worker answers every same-origin navigation with index.html, so a stale
  // bookmark boots the shell on a path no route matches. Without a wildcard the router
  // reports "Cannot match any routes" and the outlet stays empty forever.
  it('resolves an unknown URL to the rooms route', async () => {
    const router = await navigate('/does-not-exist');

    expect(router.url).toBe('/rooms');
  });

  it('resolves a deep unknown URL to the rooms route', async () => {
    const router = await navigate('/rooms/legacy/!abc:example.org/thread');

    expect(router.url).toBe('/rooms');
  });

  it('still resolves the empty path to the rooms route', async () => {
    const router = await navigate('/');

    expect(router.url).toBe('/rooms');
  });

  it('leaves a known route alone', async () => {
    const router = await navigate('/login');

    expect(router.url).toBe('/login');
  });

  // Route order is load-bearing: the router takes the first match, so a wildcard placed
  // above the real routes would swallow all of them.
  it('declares the wildcard last', () => {
    expect(routes[routes.length - 1]).toMatchObject({
      path: '**',
      redirectTo: 'rooms',
    });
  });
});

/**
 * The route table is the app's only authentication boundary — `authGuard` is what
 * restores a persisted session or sends a signed-out visitor to /login. A route added
 * without it renders a page that reads `matrix.instance` with no client behind it, and
 * nothing else in the workspace would notice: the page's own spec provides a mocked
 * client, and the E2E suite always logs in first.
 */
describe('app route guards', () => {
  /** The routes that are deliberately reachable signed out, by path. */
  const PUBLIC_PATHS = ['login', 'sso-callback', 'spike'];
  /** Pure redirects — they carry no component, so there is nothing to guard. */
  const isRedirect = (route: (typeof routes)[number]): boolean =>
    route.redirectTo !== undefined;

  it('guards every routed page that is not deliberately public', () => {
    const unguarded = routes
      .filter(
        (route) =>
          !isRedirect(route) && !PUBLIC_PATHS.includes(route.path ?? ''),
      )
      .filter((route) => !(route.canActivate ?? []).includes(authGuard))
      .map((route) => route.path);

    expect(unguarded).toEqual([]);
  });

  it('leaves the public routes unguarded', () => {
    // The other half: authGuard on /login would redirect a signed-out user to /login.
    for (const path of PUBLIC_PATHS) {
      const route = routes.find((candidate) => candidate.path === path);
      // `spike` is dev-only and absent from a production table.
      if (!route) continue;
      expect(route.canActivate ?? [], `${path} must stay public`).toEqual([]);
    }
  });

  // A recovery key is displayed exactly once and never persisted, and on a narrow layout
  // these are full pages the browser's own back button tears down without asking.
  it('confirms before leaving each route that shows a one-time recovery key', () => {
    for (const path of ['encryption/setup', 'encryption/unlock']) {
      const route = routes.find((candidate) => candidate.path === path);

      expect(
        route?.canDeactivate ?? [],
        `${path} needs a leave guard`,
      ).toHaveLength(1);
    }
  });

  /**
   * The room lives in the URL, and the shell must SURVIVE it changing.
   *
   * `/rooms` and `/rooms/<segment>` are one Route object on purpose. Angular's default reuse
   * strategy is `future.routeConfig === curr.routeConfig` — an identity check on the Route,
   * not on the component — so writing these as two sibling entries sharing a `loadComponent`
   * destroys and rebuilds the page on every open-a-room and every close-back-to-the-list.
   *
   * That is not a performance nit. `RoomsPage.providers` holds `RoomShellStore` and the twelve
   * shell coordinators, so a rebuild resets the selected space, the sidebar view and the room
   * filter: clicking a room inside a space would snap the sidebar back to Recent, and the
   * page's `ngOnDestroy` would tear down the timeline, thread and pinned projections a moment
   * before the new instance re-opened them.
   *
   * Counted rather than reasoned about, because the reasoning is what was wrong the first time.
   */
  describe('the rooms shell across a room change', () => {
    let constructed = 0;
    let destroyed = 0;

    @Component({ template: '' })
    class CountingShellComponent implements OnDestroy {
      constructor() {
        constructed++;
      }
      ngOnDestroy(): void {
        destroyed++;
      }
    }

    /** The REAL matcher from app.routes.ts, with only the component swapped. */
    const roomsRoute = routes.find((route) => route.matcher);

    async function walk(urls: string[]): Promise<void> {
      constructed = 0;
      destroyed = 0;
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              matcher: roomsRoute!.matcher!,
              component: CountingShellComponent,
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      for (const url of urls) {
        await harness.navigateByUrl(url);
      }
    }

    it('is one route, so the page is never rebuilt when the room changes', async () => {
      await walk([
        '/rooms',
        '/rooms/IWE6aHM',
        '/rooms/IWI6aHM',
        '/rooms',
        '/rooms/IWM6aHM',
      ]);

      // Five navigations, one shell. With two sibling entries this is 5 and 4.
      expect(constructed).toBe(1);
      expect(destroyed).toBe(0);
    });

    it('still matches both shapes, and nothing longer', () => {
      const segments = (path: string) =>
        path.split('/').map((part) => new UrlSegment(part, {}));

      expect(roomsRoute!.matcher!(segments('rooms'), null!, null!)).toEqual({
        consumed: segments('rooms'),
      });
      // The room arrives as a positional parameter, which is what `paramMap` reads.
      const withRoom = roomsRoute!.matcher!(
        segments('rooms/IWE6aHM'),
        null!,
        null!,
      );
      expect(withRoom?.posParams?.['roomId'].path).toBe('IWE6aHM');
      // A deeper path is somebody else's — falling through to the wildcard, not swallowed.
      expect(
        roomsRoute!.matcher!(segments('rooms/IWE6aHM/extra'), null!, null!),
      ).toBeNull();
      expect(
        roomsRoute!.matcher!(segments('settings'), null!, null!),
      ).toBeNull();
    });
  });
});
