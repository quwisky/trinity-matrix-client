import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
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
 * into this run. Paths, redirects and `pathMatch` are copied verbatim, so deleting the
 * wildcard from app.routes.ts still fails these tests.
 */
const pathTable: Routes = routes.map((route) =>
  route.redirectTo === undefined
    ? { path: route.path, component: BlankComponent }
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
});
